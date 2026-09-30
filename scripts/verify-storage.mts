// 用 localStorage 桩验证存储层：旧数据迁移 + 两阶段写入失败回滚
import { pathToFileURL } from 'node:url'

function createMemoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  }
}

const storage = createMemoryStorage()
;(globalThis as any).window = { localStorage: storage, setTimeout }

const storageUrl = pathToFileURL(`${process.cwd()}/src/services/storage.ts`).href
const mockUrl = pathToFileURL(`${process.cwd()}/src/data/mock.ts`).href
const mod = await import(storageUrl)
const { createInitialState } = await import(mockUrl)

let pass = 0
let fail = 0
function assert(cond: boolean, name: string) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name}`)
  }
}

// ---- 场景 1：旧数据缺版本，加载时补初始快照并迁移一次 ----
console.log('场景1 旧数据迁移')
const legacy = createInitialState()
const legacyState: any = {
  ...legacy,
  schemaVersion: undefined,
  devices: legacy.devices.map(({ version, ...rest }: any) => rest),
  settings: legacy.settings.map(({ version, ...rest }: any) => rest),
  issues: legacy.issues.map(({ validity, basis, ...rest }: any) => rest),
  baselines: legacy.baselines.map((b: any) => {
    const { settingVersions, ...rest } = b
    return { ...rest, snapshot: rest.snapshot.map(({ version, ...s }: any) => s) }
  }),
  settingDrafts: undefined,
  recoveryNotices: undefined,
}
storage.setItem('grid-protection-review-v1', JSON.stringify(legacyState))

const migrated: any = mod.loadState()
assert(migrated.schemaVersion === 2, 'schemaVersion 迁移为 2')
assert(migrated.settings.every((s: any) => s.version === 1), '9 份定值补齐 version=1')
assert(migrated.devices.every((d: any) => d.version === 1), '设备补齐 version=1')
assert(
  migrated.issues.every((i: any) => i.validity === 'current' && typeof i.basis === 'object'),
  '旧问题标记为 current 并补齐 basis',
)
assert(
  migrated.baselines.every((b: any) => typeof b.settingVersions === 'object'),
  '基线补齐 settingVersions',
)
assert(migrated.recoveryNotices.length === 1, '生成一条迁移影响通知')
assert(
  migrated.recoveryNotices[0].affectedSettings.length === migrated.settings.length,
  '迁移通知列出全部受影响定值',
)
assert(
  migrated.recoveryNotices[0].affectedIssues.length >= 1,
  '迁移通知列出受影响校验问题',
)

// 再次加载不应重复迁移 / 重复通知
const secondLoad: any = mod.loadState()
assert(secondLoad.recoveryNotices.length === 1, '重开不重复迁移（通知仍保留 1 条）')

// ---- 场景 2：写入失败后从原批次恢复，不留半套结果 ----
console.log('场景2 两阶段写入失败回滚')
storage.clear()
const base: any = mod.loadState()
const beforeId = base.audit[0]?.id
const beforeIssues = base.issues.length

const next: any = JSON.parse(JSON.stringify(base))
next.settings[0] = { ...next.settings[0], currentA: 99.9, version: 2 }
next.issues = [{ ...next.issues[0], message: '半套结果不应存在' }]
next.audit.unshift({ id: 'audit-half', action: '半套', target: 'x', operator: 'y', detail: 'z', createdAt: new Date().toISOString() })

mod.armNextWriteFailure()
let threw = false
try {
  mod.commitState(next, '修改定值 set-1')
} catch (e) {
  threw = true
}
assert(threw, '写入失败抛出异常')

// 主状态此时仍是旧数据
const persistedRaw = JSON.parse(storage.getItem('grid-protection-review-v1')!)
assert(persistedRaw.settings[0].currentA !== 99.9, '主状态未被半套结果覆盖')
assert(persistedRaw.audit[0]?.id !== 'audit-half', '半套审计未进入主状态')

// 重开：日志触发回滚恢复
const restored: any = mod.loadState()
assert(restored.settings[0].currentA !== 99.9, '重开后定值从原批次恢复')
assert(!restored.audit.some((a: any) => a.id === 'audit-half'), '半套审计被回滚')
assert(restored.issues.length === beforeIssues, '问题列表恢复为原批次')
const rollbackNotice = restored.recoveryNotices.find((n: any) => n.kind === 'rollback')
assert(Boolean(rollbackNotice), '生成回滚恢复通知')
assert(
  rollbackNotice?.affectedSettings.some((s: any) => s.settingId === restored.settings[0].id),
  '回滚通知列出受影响定值',
)
// 日志应已清除
assert(storage.getItem('grid-protection-review-v1-journal') === null, '恢复后日志清除')

// 再重开不应再次回滚/重复通知
const reopen: any = mod.loadState()
assert(
  reopen.recoveryNotices.filter((n: any) => n.kind === 'rollback').length === 1,
  '再次重开不重复回滚',
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
