import type {
  AppState,
  Device,
  ProtectionSetting,
  RecoveryNotice,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'

const STORAGE_KEY = 'grid-protection-review-v1'
const JOURNAL_KEY = 'grid-protection-review-v1-journal'
/** 置位后下一次状态写入必定失败，用于演示写入中断后的批次恢复 */
const FAIL_NEXT_KEY = 'grid-protection-review-fail-next-write'
const CURRENT_SCHEMA_VERSION = 2

type JournalPayload = {
  batchId: string
  reason: string
  backup: AppState
  attempted: AppState
  createdAt: string
}

export function armNextWriteFailure(): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(FAIL_NEXT_KEY, '1')
}

function consumeWriteFailure(): boolean {
  if (typeof window === 'undefined') return false
  if (window.localStorage.getItem(FAIL_NEXT_KEY) === '1') {
    window.localStorage.removeItem(FAIL_NEXT_KEY)
    return true
  }
  return false
}

function readJournal(): JournalPayload | undefined {
  if (typeof window === 'undefined') return undefined
  const raw = window.localStorage.getItem(JOURNAL_KEY)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as JournalPayload
  } catch {
    return undefined
  }
}

function clearJournal(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(JOURNAL_KEY)
}

/**
 * 两阶段原子写入：
 * 1. 写入前把「原批次（当前持久化状态）+ 待写入状态 + 批次原因」记入日志；
 * 2. 用新状态覆盖主状态；
 * 3. 写入成功标记并清除日志。
 * 若第 2 步失败或在中途中断，下次加载时 loadState 会依据日志从原批次恢复。
 */
export function commitState(
  next: AppState,
  reason: string,
): { state: AppState; recovered: false } {
  const previous = loadState()
  const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const journal: JournalPayload = {
    batchId,
    reason,
    backup: previous,
    attempted: next,
    createdAt: new Date().toISOString(),
  }

  window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal))
  if (consumeWriteFailure()) {
    throw new Error('本地存储写入失败，已保留原批次以便恢复')
  }
  const stamped: AppState = { ...next, pendingBatch: undefined }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped))
  clearJournal()
  return { state: stamped, recovered: false }
}

function settingLabel(setting: ProtectionSetting | undefined, fallbackId: string): string {
  if (!setting) return fallbackId
  return `${setting.relayId} ${setting.stage} 段`
}

function issuesOf(
  issueIds: string[],
  source: ValidationIssue[],
): RecoveryNotice['affectedIssues'] {
  return issueIds
    .map((id) => source.find((issue) => issue.id === id))
    .filter((issue): issue is ValidationIssue => Boolean(issue))
    .map((issue) => ({
      issueId: issue.id,
      pairLabel: issue.pairLabel,
      message: issue.message,
    }))
}

/** 从日志回滚到原批次，并生成重开后仍可见的影响说明 */
function rollbackFromJournal(journal: JournalPayload): AppState {
  const restored: AppState = {
    ...journal.backup,
    pendingBatch: undefined,
  }
  const backupById = new Map(restored.settings.map((item) => [item.id, item]))
  const attemptedById = new Map(journal.attempted.settings.map((item) => [item.id, item]))
  const affectedSettingIds = new Set<string>()
  attemptedById.forEach((attempted, id) => {
    const backup = backupById.get(id)
    if (!backup || backup.version !== attempted.version) affectedSettingIds.add(id)
  })
  // 原批次中因版本变化而失效、尚未重新确认的问题也要列出来
  const staleIssueIds = restored.issues
    .filter((issue) => issue.validity === 'stale')
    .map((issue) => issue.id)
  staleIssueIds.forEach((id) => {
    const issue = restored.issues.find((item) => item.id === id)
    issue?.settingIds.forEach((settingId) => affectedSettingIds.add(settingId))
  })

  const notice: RecoveryNotice = {
    id: `recovery-${journal.batchId}`,
    kind: 'rollback',
    reason: journal.reason,
    restoredAt: new Date().toISOString(),
    affectedSettings: [...affectedSettingIds].map((settingId) => {
      const setting = backupById.get(settingId)
      return {
        settingId,
        relayId: setting?.relayId ?? '',
        label: settingLabel(setting, settingId),
      }
    }),
    affectedIssues: issuesOf(staleIssueIds, restored.issues),
    detail: `批次 ${journal.batchId} 在写入「${journal.reason}」时中断，系统已从原批次恢复；该批次中的修改未生效。`,
  }
  restored.recoveryNotices = [notice, ...(restored.recoveryNotices ?? [])].slice(0, 20)
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(restored))
  clearJournal()
  return restored
}

type LegacyState = Partial<AppState> & {
  devices?: Array<Partial<Device> & Device>
  settings?: Array<Partial<ProtectionSetting> & ProtectionSetting>
  issues?: ValidationIssue[]
  baselines?: AppState['baselines']
}

function migrate(raw: LegacyState): { state: AppState; migrated: boolean } {
  const needsVersionMigration =
    !raw.schemaVersion ||
    (raw.settings ?? []).some((setting) => typeof setting.version !== 'number') ||
    (raw.devices ?? []).some((device) => typeof device.version !== 'number')

  if (!needsVersionMigration) {
    return { state: { ...createInitialState(), ...raw } as AppState, migrated: false }
  }

  // 旧数据缺少版本信息：为现有设备 / 定值补初始版本快照，只迁移一次。
  const devices: Device[] = (raw.devices ?? []).map((device) => ({
    ...device,
    version: typeof device.version === 'number' ? device.version : 1,
  }))
  const settings: ProtectionSetting[] = (raw.settings ?? []).map((setting) => ({
    ...setting,
    version: typeof setting.version === 'number' ? setting.version : 1,
  }))

  const settingsById = new Map(settings.map((item) => [item.id, item]))
  const migratedIssueIdsList: string[] = []
  const issues: ValidationIssue[] = (raw.issues ?? []).map((issue) => {
    const basis: Record<string, number> = {}
    issue.settingIds.forEach((settingId) => {
      basis[settingId] = settingsById.get(settingId)?.version ?? 1
    })
    if (issue.validity !== 'current' && issue.validity !== 'stale') {
      migratedIssueIdsList.push(issue.id)
    }
    return {
      ...issue,
      validity: 'current',
      basis: Object.keys(issue.basis ?? {}).length ? issue.basis : basis,
    }
  })

  const baselines = (raw.baselines ?? []).map((baseline) => {
    if (baseline.settingVersions) return baseline
    const settingVersions: Record<string, number> = {}
    baseline.snapshot.forEach((setting) => {
      settingVersions[setting.id] = 1
    })
    const snapshot = baseline.snapshot.map((setting) =>
      typeof setting.version === 'number' ? setting : { ...setting, version: 1 },
    )
    return { ...baseline, snapshot, settingVersions }
  })

  const affectedSettingIds = new Set<string>()
  settings.forEach((setting) => affectedSettingIds.add(setting.id))
  issues.forEach((issue) => {
    if (issue.validity === 'stale') issue.settingIds.forEach((id) => affectedSettingIds.add(id))
  })

  const state: AppState = {
    ...createInitialState(),
    ...raw,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    devices,
    settings,
    issues,
    baselines,
    settingDrafts: raw.settingDrafts ?? [],
    recoveryNotices: raw.recoveryNotices ?? [],
  } as AppState

  const migratedIssueIds = new Set<string>(migratedIssueIdsList)
  issues.forEach((issue) => {
    if (issue.validity === 'stale') {
      migratedIssueIds.add(issue.id)
      issue.settingIds.forEach((id) => affectedSettingIds.add(id))
    }
  })

  const notice: RecoveryNotice = {
    id: `migration-${Date.now()}`,
    kind: 'migration',
    reason: '旧数据缺少版本信息',
    restoredAt: new Date().toISOString(),
    affectedSettings: [...affectedSettingIds].map((settingId) => {
      const setting = settingsById.get(settingId)
      return {
        settingId,
        relayId: setting?.relayId ?? '',
        label: settingLabel(setting, settingId),
      }
    }),
    affectedIssues: issuesOf([...migratedIssueIds], issues),
    detail: `已为 ${settings.length} 份定值、${devices.length} 台设备补充初始版本快照（V1），并重算校验问题的版本依据；迁移仅执行一次。`,
  }
  state.recoveryNotices = [notice, ...state.recoveryNotices].slice(0, 20)
  return { state, migrated: true }
}

export function loadState(): AppState {
  if (typeof window === 'undefined') return createInitialState()

  // 启动时先检查上次是否留下未完成的写入批次：有则从原批次恢复。
  const journal = readJournal()
  if (journal) {
    const restored = rollbackFromJournal(journal)
    // 恢复完成后仍继续走迁移流程，确保结构最新。
    const reparsed: LegacyState = JSON.parse(JSON.stringify(restored)) as LegacyState
    const { state, migrated } = migrate(reparsed)
    if (migrated) saveState(state)
    return state
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
  let parsed: LegacyState
  try {
    parsed = JSON.parse(raw) as LegacyState
  } catch {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }

  const { state, migrated } = migrate(parsed)
  if (migrated) saveState(state)
  return state
}

/** 直接覆盖保存（初始化 / 重置 / 恢复落盘使用，不记日志） */
export function saveState(state: AppState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, schemaVersion: CURRENT_SCHEMA_VERSION }),
    )
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  clearJournal()
  saveState(initial)
  return initial
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
