/* 逻辑冒烟测试：不依赖浏览器，使用内存版 localStorage 模拟 */
import assert from 'node:assert'

// ---- 内存 localStorage ----
const mem = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size
  },
} as Storage
;(globalThis as any).window = {
  localStorage: globalThis.localStorage,
  setTimeout: (fn: () => void) => {
    fn()
    return 0 as unknown as number
  },
}

import { loadState, saveState, armWriteFailure, resetState, armConflict } from '../src/services/storage'
import { migrateState } from '../src/services/migration'
import { computeConflictFields } from '../src/services/concurrency'
import { recomputeIssues, validateSettings } from '../src/services/validation'
import { createInitialState } from '../src/data/mock'

let passed = 0
function ok(name: string) {
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 1. 初始装载
resetState()
let env = loadState()
assert.equal(env.state.devices[0].version, 1, '旧装置应补 version=1')
assert.equal(env.state.schemaVersion, 2)
assert.ok(env.state.relaySnapshots.length > 0, '应有初始版本快照')
assert.ok(env.state.issues.every((i) => i.baseVersions), '问题应带版本基线')
assert.ok(env.state.validationBatches.length === 1, '应有初始校验批次')
ok('初始数据：装置 V1、初始快照、问题版本基线、校验批次')

// 2. 乐观锁：后保存不得盖掉先保存
const rev1 = env.revision
const stateA = JSON.parse(JSON.stringify(env.state))
stateA.settings[0].currentA = 12.3
const r1 = saveState(stateA, rev1)
assert.ok(!('conflict' in r1), '首次保存应成功')
assert.equal((r1 as any).revision, rev1 + 1)

const stateBLate = JSON.parse(JSON.stringify(env.state)) // 基于旧修订
stateBLate.settings[0].timeS = 0.99
const r2 = saveState(stateBLate, rev1)
assert.ok('conflict' in r2, '旧修订号提交必须冲突')
assert.equal((r2 as any).server.state.settings[0].currentA, 12.3, '服务端保持先到值')
ok('乐观锁：后保存被拒绝，先保存结果未被覆盖')

// 3. 冲突字段计算
env = loadState()
const server = env.state.settings.find((s) => s.id === 'set-l101-1')!
const base = { ...server, currentA: 8.4 }
server.currentA = 9.0 // 他端改了电流
const draft = { ...base, currentA: 7.0, timeS: 0.5 } // 我改了电流+时限
const conflicts = computeConflictFields(draft, base, { ...server })
assert.ok(conflicts.some((c) => c.field === 'currentA'), '电流应冲突')
assert.ok(!conflicts.some((c) => c.field === 'timeS'), '仅我改动时限不冲突（服务器未动）')
ok('冲突字段：只列出双方都偏离基准的字段')

// 4. 版本变化 → 问题失效
{
  const fresh = createInitialState()
  const beforeCount = fresh.issues.length
  const l101 = fresh.devices.find((d) => d.id === 'relay-l101')!
  l101.version = 2
  const { markStaleIssues } = await import('../src/services/concurrency')
  fresh.issues = markStaleIssues(fresh.issues, fresh.devices)
  const staleRel = fresh.issues.filter((i) =>
    Object.keys(i.baseVersions ?? {}).includes('relay-l101'),
  )
  assert.ok(staleRel.every((i) => i.stale), '涉及 l101 的问题应失效')
  assert.ok(staleRel.every((i) => i.status === 'open'), '失效问题回到待处理')
  const unrelated = fresh.issues.filter(
    (i) => !Object.keys(i.baseVersions ?? {}).includes('relay-l101'),
  )
  assert.ok(unrelated.every((i) => !i.stale), '不涉及的装置问题不应失效')

  // 重算后保留未失效问题的人工状态
  fresh.issues.forEach((i) => {
    if (!i.stale) i.status = 'closed'
  })
  const recomputed = recomputeIssues(fresh.issues, fresh.settings, fresh.devices, 'batch-new')
  assert.ok(
    recomputed.filter((i) => !i.settingIds.some((id) => fresh.settings.find((s) => s.id === id)?.relayId === 'relay-l101')).every((i) => i.status === 'closed'),
    '装置未变的问题重算后保留已关闭状态',
  )
  const backAlive = recomputed.filter((i) => i.baseVersions?.['relay-l101'])
  assert.ok(backAlive.every((i) => i.status === 'open'), '曾失效问题重算后回到待处理')
  assert.ok(recomputed.every((i) => i.batchId === 'batch-new'))
  assert.ok(beforeCount >= recomputed.length)
  ok('版本变化：关联问题失效回待处理；重算保留未变问题状态、失效问题需重新确认')
}

// 5. 批次原子性：validate 是纯函数，store 只在完整跑完后替换（这里验证完整批次字段一致）
{
  const fresh = createInitialState()
  const issues = validateSettings(fresh.settings, fresh.devices, { batchId: 'b1' })
  const relayVersions: Record<string, number> = {}
  fresh.settings.forEach((s) => (relayVersions[s.relayId] = 1))
  const batch = {
    id: 'b1',
    startedAt: 'x',
    finishedAt: 'y',
    relayVersions,
    issueIds: issues.map((i) => i.id),
  }
  const { isBatchIntact } = await import('../src/services/concurrency')
  assert.ok(isBatchIntact(batch, fresh.devices, issues), '完整批次应通过校验')
  fresh.devices.find((d) => d.id === 'relay-l101')!.version = 3
  assert.ok(!isBatchIntact(batch, fresh.devices, issues), '版本漂移后批次不完整')
  ok('批次完整性：版本漂移后旧批次不可作为锁定依据')
}

// 6. 写入失败 → 原批次不动
{
  resetState()
  const before = loadState()
  const changed = JSON.parse(JSON.stringify(before.state))
  changed.settings[0].currentA = 42
  armWriteFailure()
  assert.throws(() => saveState(changed, before.revision), /回滚|失败/)
  const after = loadState()
  assert.equal(after.state.settings[0].currentA, before.state.settings[0].currentA, '原批次定值未变')
  assert.equal(after.revision, before.revision, '修订号未推进')
  ok('写入失败：存储层原批次完整保留（store 层负责内存回滚+恢复通知）')
}

// 7. 旧数据迁移：无 schemaVersion / 无 version
{
  const old = createInitialState()
  const legacy = JSON.parse(JSON.stringify(old))
  delete (legacy as any).schemaVersion
  delete (legacy as any).drafts
  delete (legacy as any).validationBatches
  delete (legacy as any).relaySnapshots
  delete (legacy as any).notices
  legacy.devices.forEach((d: any) => delete d.version)
  legacy.issues.forEach((i: any) => delete i.baseVersions)
  legacy.baselines.forEach((b: any) => delete b.relayVersions)
  const migrated = migrateState(legacy)
  assert.equal(migrated.schemaVersion, 2)
  assert.ok(migrated.devices.every((d) => d.version === 1))
  assert.ok(migrated.relaySnapshots.length === migrated.devices.filter((d) => d.kind === 'relay').length)
  assert.ok(migrated.issues.every((i) => i.stale === true), '旧问题应标记失效')
  assert.ok(migrated.issues.every((i) => i.baseVersions), '旧问题应补版本基线')
  assert.ok(migrated.baselines.every((b) => b.relayVersions))
  ok('旧数据迁移：补初始快照一次完成，旧结论标失效待重算')
}

// 8. 基线只冻结已确认问题（通过 store 规则函数验证条件）
{
  const { unconfirmedBlockingIssues } = await import('../src/services/concurrency')
  const fresh = createInitialState()
  // 高风险问题默认 open → 应阻止
  assert.ok(unconfirmedBlockingIssues(fresh).length > 0)
  fresh.issues.forEach((i) => {
    if (i.level === 'high') i.status = 'closed'
  })
  assert.equal(unconfirmedBlockingIssues(fresh).length, 0, '高风险全关后不阻止')
  // 已关闭但失效 → 仍阻止
  fresh.issues[0].stale = true
  fresh.issues[0].level = 'high'
  assert.ok(unconfirmedBlockingIssues(fresh).length > 0, '失效问题即使关闭也阻止锁定')
  ok('基线门禁：未确认（未关闭或失效）问题不能随旧结论锁进基线')
}

console.log(`\n全部 ${passed} 组逻辑断言通过 ✅`)
