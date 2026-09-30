import type { AppState, SystemNotice } from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { CURRENT_SCHEMA_VERSION, migrateState } from '@/services/migration'

const STORAGE_KEY = 'grid-protection-review-v1'
const REVISION_KEY = 'grid-protection-review-rev'
const NOTICES_KEY = 'grid-protection-review-notices-v2'
/** 故障注入：置位后下一次写入返回 500（模拟写入失败） */
const FAIL_NEXT_KEY = 'grid-protection-review-fail-next'
/** 故障注入：置位后下一次写入返回 409（模拟其他终端已抢先提交） */
const CONFLICT_NEXT_KEY = 'grid-protection-review-conflict-next'

export interface StateEnvelope {
  state: AppState
  revision: number
}

function readRevision(): number {
  const storage = globalThis.localStorage
  if (!storage) return 0
  const raw = storage.getItem(REVISION_KEY)
  const value = raw ? Number(raw) : 0
  return Number.isFinite(value) ? value : 0
}

function writeRevision(value: number): void {
  globalThis.localStorage?.setItem(REVISION_KEY, String(value))
}

export function loadNotices(): SystemNotice[] {
  const storage = globalThis.localStorage
  if (!storage) return []
  try {
    const raw = storage.getItem(NOTICES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as SystemNotice[]) : []
  } catch {
    return []
  }
}

export function saveNotices(notices: SystemNotice[]): void {
  globalThis.localStorage?.setItem(NOTICES_KEY, JSON.stringify(notices))
}

/** 读取本地数据；旧数据缺装置版本时补初始快照，迁移只执行一次并立即落库 */
export function loadState(): StateEnvelope {
  const storage = globalThis.localStorage
  if (!storage) {
    return { state: createInitialState(), revision: 0 }
  }
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    storage.setItem(STORAGE_KEY, JSON.stringify(initial))
    writeRevision(1)
    return { state: initial, revision: 1 }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const initial = createInitialState()
    storage.setItem(STORAGE_KEY, JSON.stringify(initial))
    writeRevision(1)
    return { state: initial, revision: 1 }
  }

  const record = parsed as { schemaVersion?: number }
  const needsMigration =
    !record || typeof record.schemaVersion !== 'number' || record.schemaVersion < CURRENT_SCHEMA_VERSION

  if (!needsMigration) {
    return { state: parsed as AppState, revision: readRevision() }
  }

  const migrated = migrateState(parsed)
  const staleIssues = migrated.issues.filter((issue) => issue.stale)
  const affectedSettingIds = [...new Set(staleIssues.flatMap((issue) => issue.settingIds))]
  const notices = loadNotices()
  if (!notices.some((notice) => notice.kind === 'migration')) {
    notices.unshift({
      id: 'notice-migration-v2',
      kind: 'migration',
      title: '旧版本数据已迁移：补建装置版本初始快照',
      detail:
        '历史数据缺少装置版本字段，已按当前定值补建各保护装置 V1 初始快照；旧校验结论缺少版本依据，已标记为失效，需要重新批量校验后确认。',
      at: new Date().toISOString(),
      relayIds: migrated.devices.filter((device) => device.kind === 'relay').map((d) => d.id),
      settingIds: affectedSettingIds,
      issueIds: staleIssues.map((issue) => issue.id),
      dismissed: false,
    })
    saveNotices(notices)
  }
  migrated.notices = notices
  storage.setItem(STORAGE_KEY, JSON.stringify(migrated))
  const revision = readRevision() + 1
  writeRevision(revision)
  return { state: migrated, revision }
}

export interface SaveResult {
  envelope: StateEnvelope
  migrated: boolean
}

/**
 * 乐观锁写入：expectedRevision 与服务端不一致时拒绝（后保存不得盖掉先保存）。
 * @returns 拒绝时返回 null，由调用方走冲突草稿流程
 */
export function saveState(
  state: AppState,
  expectedRevision: number,
): StateEnvelope | { conflict: true; server: StateEnvelope } {
  const storage = globalThis.localStorage
  if (!storage) {
    return { state, revision: expectedRevision }
  }

  // 故障注入优先：模拟写入中断，原批次保持不动
  if (storage.getItem(FAIL_NEXT_KEY) === '1') {
    storage.removeItem(FAIL_NEXT_KEY)
    throw new Error('模拟写入失败：本地存储不可用，事务已回滚')
  }

  const currentRevision = readRevision()
  if (currentRevision !== expectedRevision) {
    const stored = storage.getItem(STORAGE_KEY)
    const serverState = stored ? (JSON.parse(stored) as AppState) : createInitialState()
    return { conflict: true, server: { state: serverState, revision: currentRevision } }
  }

  // 模拟他端抢先提交：拒绝本次写入。先把磁盘真值读出，再只对目标定值施加“他端修改”
  if (storage.getItem(CONFLICT_NEXT_KEY) === '1') {
    storage.removeItem(CONFLICT_NEXT_KEY)
    const storedRaw = storage.getItem(STORAGE_KEY)
    const serverState: AppState = storedRaw
      ? (JSON.parse(storedRaw) as AppState)
      : createInitialState()
    const targetSettingId = storage.getItem('grid-protection-conflict-target')
    storage.removeItem('grid-protection-conflict-target')
    const target = serverState.settings.find((item) => item.id === targetSettingId)
    if (target) {
      target.currentA = Number((target.currentA + 0.2).toFixed(2))
      target.updatedAt = new Date().toISOString()
      const relay = serverState.devices.find((device) => device.id === target.relayId)
      if (relay) {
        relay.version += 1
        relay.versionUpdatedAt = new Date().toISOString()
      }
    }
    const nextRevision = currentRevision + 1
    storage.setItem(STORAGE_KEY, JSON.stringify(serverState))
    writeRevision(nextRevision)
    return { conflict: true, server: { state: serverState, revision: nextRevision } }
  }

  const nextRevision = currentRevision + 1
  storage.setItem(STORAGE_KEY, JSON.stringify(state))
  writeRevision(nextRevision)
  return { state, revision: nextRevision }
}

export function resetState(): StateEnvelope {
  const initial = createInitialState()
  const storage = globalThis.localStorage
  if (storage) {
    storage.setItem(STORAGE_KEY, JSON.stringify(initial))
    writeRevision(1)
    saveNotices([])
  }
  return { state: initial, revision: 1 }
}

export function armWriteFailure(): void {
  globalThis.localStorage?.setItem(FAIL_NEXT_KEY, '1')
}

export function armConflict(targetSettingId?: string): void {
  const storage = globalThis.localStorage
  if (!storage) return
  storage.setItem(CONFLICT_NEXT_KEY, '1')
  if (targetSettingId) {
    storage.setItem('grid-protection-conflict-target', targetSettingId)
  }
}

export function exportSettingsText(state: AppState): string {
  const lines = [
    '电网继电保护定值清单',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    '装置编号,保护装置,保护对象,段位,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件',
  ]
  state.settings.forEach((setting) => {
    const relay = state.devices.find((device) => device.id === setting.relayId)?.name ?? setting.relayId
    const target =
      state.devices.find((device) => device.id === setting.protectedDeviceId)?.name ??
      setting.protectedDeviceId
    lines.push(
      [
        setting.relayId,
        relay,
        target,
        setting.stage,
        setting.currentA,
        setting.timeS,
        setting.direction,
        setting.sensitivity,
        setting.recloseEnabled ? '投入' : '退出',
        setting.recloseDelayS,
        setting.startCondition,
      ].join(','),
    )
  })
  return lines.join('\n')
}
