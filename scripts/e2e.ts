/* 端到端：在最小浏览器环境里驱动真实 store（pinia）+ mock 存储 */
import assert from 'node:assert'
import { AxiosError, type AxiosAdapter } from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import { fetchState, http, injectConflict, injectWriteFailure } from '../src/api/client'
import { useAppStore } from '../src/stores/app'
import { runMock } from './mock-server'

// ---------- 浏览器环境 shim ----------
const mem = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
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
    return 0
  },
  clearTimeout: () => {},
}

// axios 在 node 默认走 http，这里注入自定义适配器桥接到内存 mock
const bridgeAdapter: AxiosAdapter = async (config) => {
  const method = (config.method ?? 'get').toUpperCase()
  const url = `${config.baseURL ?? ''}${config.url ?? ''}`
  const res = await runMock(method, url, (config.data as string | null) ?? null)
  const response = {
    data: res.data,
    status: res.status,
    statusText: String(res.status),
    headers: {},
    config,
  }
  if (res.status < 200 || res.status >= 300) {
    const error = new AxiosError(
      `Request failed with status code ${res.status}`,
      AxiosError.ERR_BAD_REQUEST,
      config,
      null,
      response,
    )
    throw error
  }
  return response
}
http.defaults.adapter = bridgeAdapter

async function main() {
  setActivePinia(createPinia())
  const store = useAppStore()

  let passed = 0
  const ok = (n: string) => {
    passed++
    console.log(`  ✓ ${n}`)
  }

  // 水合
  const env = await fetchState()
  store.hydrate(env)
  const relay = store.devices.find((d) => d.id === 'relay-l101')!
  const setting = store.settings.find((s) => s.id === 'set-l101-1')!
  assert.equal(relay.version, 1)

  // 场景一：并发保存 → 晚到提交保留草稿、列冲突字段
  await injectConflict(setting.id)
  const myDraft = { ...setting, currentA: 7.77 }
  const res1 = await store.saveSetting(myDraft, 1 /* 冻结 V1 */, { ...setting })
  assert.equal(res1.outcome, 'conflict', '应返回冲突')
  if (res1.outcome === 'conflict') {
    assert.ok(res1.draft.conflictFields.some((f) => f.field === 'currentA'), '应列出电流冲突')
    assert.equal(store.drafts.length, 1, '草稿应保留')
    const server = store.settings.find((s) => s.id === setting.id)!
    assert.notEqual(server.currentA, 7.77, '服务器现值不被晚到草稿覆盖')
    assert.equal(store.devices.find((d) => d.id === 'relay-l101')!.version, 2)
    ok('并发：晚到提交未覆盖，草稿保留并列出冲突字段，他端版本已 V2')

    // 场景二：合并草稿重新保存成功
    const baseNow = { ...server }
    const merged = { ...myDraft, currentA: 6.5 }
    const res2 = await store.resolveDraft(res1.draft.id, 'reopen', merged, baseNow)
    assert.equal(res2.outcome, 'saved')
    assert.equal(store.settings.find((s) => s.id === setting.id)!.currentA, 6.5)
    assert.equal(store.devices.find((d) => d.id === 'relay-l101')!.version, 3)
    assert.equal(store.drafts.length, 0, '草稿处理后清空')
    ok('冲突合并：按合并值重新保存成功，版本继续冻结到 V3')
  }

  // 场景三：版本变化导致问题失效
  const relatedIssue = store.issues.find((i) => i.baseVersions?.['relay-l101'])!
  assert.equal(relatedIssue.stale, true, 'l101 关联问题应失效')
  assert.equal(relatedIssue.status, 'open', '失效问题回到待处理')
  ok('版本变化：关联校验问题自动失效并回到待处理')

  // 场景四：失效问题阻止基线锁定（先创建一条会签中基线）
  const reviewingBefore = await store.createBaseline('e2e 会签基线')
  await store.approveBaseline(reviewingBefore.id).then(
    () => assert.fail('应拒绝锁定'),
    (e: Error) => assert.ok(/失效/.test(e.message)),
  )
  ok('基线：存在失效待重算问题时拒绝锁定')

  // 场景五：重算完成后失效标记清除，批次登记完整
  const recomputed = await store.runValidation()
  assert.ok(recomputed.every((i) => !i.stale), '重算后无失效')
  assert.ok(
    store.validationBatches[0].issueIds.length === recomputed.length,
    '批次问题列表完整',
  )
  ok(`重算：完整批次落库（${recomputed.length} 条结论），中断不会留半成品`)

  // 场景六：高风险未关闭阻止锁定；全部确认关闭后锁定并只冻结已确认结论
  const highOpen = store.issues.filter((i) => i.level === 'high' && i.status !== 'closed')
  if (highOpen.length) {
    await store.approveBaseline(reviewingBefore.id).then(
      () => assert.fail('高风险未关闭应拒绝'),
      (e: Error) => assert.ok(/高风险/.test(e.message)),
    )
    ok('基线：高风险未确认问题阻止锁定')
  }
  for (const issue of store.issues) {
    if (issue.level === 'high') await store.updateIssue({ ...issue, status: 'closed' })
  }
  const target = await store.createBaseline('e2e 锁定基线')
  await store.approveBaseline(target.id)
  const locked = store.data.baselines.find((b) => b.id === target.id)!
  assert.equal(locked.status, 'locked')
  assert.equal(locked.relayVersions['relay-l101'], 3, '锁定快照记录 V3')
  assert.ok(Array.isArray(locked.confirmedIssues))
  assert.ok(locked.confirmedIssues!.every((i) => i.status === 'closed' && !i.stale))
  ok(`基线锁定：仅冻结 ${locked.confirmedIssues!.length} 条已确认结论，未确认问题未进入`)

  // 场景七：写入失败 → 内存从原批次恢复 + 恢复通知
  await injectWriteFailure()
  const snapshotCurrentA = store.settings.find((s) => s.id === setting.id)!.currentA
  const snapshotRev = store.revision
  try {
    await store.saveSetting({ ...setting, currentA: 99 }, 3, { ...setting })
    assert.fail('应抛出写入失败')
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.equal(
      store.settings.find((s) => s.id === setting.id)!.currentA,
      snapshotCurrentA,
      '内存已回滚到原批次',
    )
    assert.equal(store.revision, snapshotRev, '修订号回滚')
    const recovery = store.notices.find((n) => n.kind === 'recovery')
    assert.ok(recovery, '应有恢复通知')
    assert.ok(recovery!.settingIds.includes(setting.id), '通知列出受影响定值')
    ok('写入失败：内存从原批次恢复，恢复通知列出受影响定值/问题')
  }

  // 场景八：通知独立持久化，重开（重新 fetch）仍可见
  const reopened = await fetchState()
  assert.ok(reopened.state.notices.some((n) => n.kind === 'recovery'), '重开后恢复通知仍在')
  ok('重开应用：恢复记录仍可查看受影响定值与问题')

  console.log(`\n端到端 ${passed} 组场景全部通过 ✅`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
