import assert from 'node:assert'
// 模拟浏览器里已存在 v1 旧数据（无 schemaVersion / 无 version）
const oldData = {
  devices: [
    { id: 'r1', code: 'R1', name: '旧保护', kind: 'relay', station: '站', voltage: 110, status: 'running', operationModes: ['正常方式'] },
  ],
  settings: [
    { id: 's1', relayId: 'r1', protectedDeviceId: 'l1', stage: 'I', currentA: 5, timeS: 0.1, direction: 'forward', sensitivity: 1.5, recloseEnabled: false, recloseDelayS: 0, startCondition: 'x', updatedAt: '2026-01-01' },
  ],
  issues: [],
  scenarios: [],
  baselines: [{ id: 'b1', version: 'V1.0', status: 'locked', createdAt: 'x', createdBy: 'a', note: 'n', snapshot: [{ id: 's1', relayId: 'r1', protectedDeviceId: 'l1', stage: 'I', currentA: 5, timeS: 0.1, direction: 'forward', sensitivity: 1.5, recloseEnabled: false, recloseDelayS: 0, startCondition: 'x', updatedAt: '2026-01-01' }], checksum: '0000-0000' }],
  comments: [],
  audit: [],
}
const mem = new Map<string, string>([['grid-protection-review-v1', JSON.stringify(oldData)]])
globalThis.localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  get length() { return mem.size },
} as Storage
;(globalThis as any).window = { localStorage: globalThis.localStorage }

const { loadState } = await import('@/services/storage')
const env = loadState()
assert.equal(env.state.schemaVersion, 2)
assert.equal(env.state.devices[0].version, 1, '旧装置补 V1')
assert.equal(env.state.relaySnapshots.length, 1, '补 1 条初始快照')
assert.equal(env.state.relaySnapshots[0].settingIds[0], 's1', '快照覆盖旧定值')
assert.equal(env.state.baselines[0].relayVersions.r1, 1, '旧基线补装置版本')
// 再次加载不应重复迁移
const env2 = loadState()
assert.equal(env2.state.relaySnapshots.length, 1, '迁移只发生一次')
assert.ok(!env2.state.notices.some((n) => n.kind === 'migration' && n.at !== env.state.notices[0]?.at))
console.log('✓ 真实旧数据一次性迁移成功：装置 V1 / 初始快照 / 基线版本 / 不重复迁移')
