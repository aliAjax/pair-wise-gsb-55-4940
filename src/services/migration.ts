import type {
  AppState,
  Device,
  ProtectionSetting,
  RelaySnapshotEntry,
  ValidationIssue,
} from '@/types/domain'

export const CURRENT_SCHEMA_VERSION = 2

const MIGRATED_AT = '2026-09-30T00:00:00.000Z'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 旧数据缺装置版本时补初始快照（仅迁移一次） */
function migrateDevices(devices: unknown[]): Device[] {
  return (devices as Device[]).map((device) =>
    typeof device.version === 'number'
      ? device
      : { ...device, version: 1, versionUpdatedAt: MIGRATED_AT },
  )
}

function migrateIssues(issues: unknown[], settings: ProtectionSetting[]): ValidationIssue[] {
  return (issues as ValidationIssue[]).map((issue) => {
    if (issue.baseVersions) return issue
    const relayVersions: Record<string, number> = {}
    const settingIds = issue.settingIds ?? []
    settingIds.forEach((settingId) => {
      const setting = settings.find((item) => item.id === settingId)
      if (setting) relayVersions[setting.relayId] = 1
    })
    return {
      ...issue,
      // 旧结论没有版本依据，保守标记为失效，重开后需要重新校验确认
      stale: true,
      baseVersions: relayVersions,
    }
  })
}

function migrateBaselines(baselines: unknown[]): AppState['baselines'] {
  return (baselines as AppState['baselines']).map((baseline) => {
    if (baseline.relayVersions) return baseline
    const relayVersions: Record<string, number> = {}
    ;(baseline.snapshot ?? []).forEach((setting) => {
      relayVersions[setting.relayId] = 1
    })
    return {
      ...baseline,
      relayVersions,
      // 锁定基线没有冻结问题结论时，按“旧结论不可信”处理：补空结论集
      confirmedIssues: baseline.confirmedIssues ?? [],
    }
  })
}

/** 为缺版本的旧装置补初始快照，一条装置一条，迁移只发生一次 */
function buildInitialRelaySnapshots(
  devices: Device[],
  settings: ProtectionSetting[],
): RelaySnapshotEntry[] {
  const relays = devices.filter((device) => device.kind === 'relay')
  return relays.map((relay) => ({
    relayId: relay.id,
    version: 1,
    at: MIGRATED_AT,
    settingIds: settings
      .filter((setting) => setting.relayId === relay.id)
      .map((setting) => setting.id),
  }))
}

/**
 * 把任意历史形态的本地数据迁移到当前结构。
 * 旧数据：无 schemaVersion、装置无 version、问题无 baseVersions、基线无 relayVersions。
 */
export function migrateState(raw: unknown): AppState {
  if (!isRecord(raw)) throw new Error('本地数据结构已损坏')

  const devices = migrateDevices(Array.isArray(raw.devices) ? raw.devices : [])
  const settings = (Array.isArray(raw.settings) ? raw.settings : []) as ProtectionSetting[]
  const issues = migrateIssues(Array.isArray(raw.issues) ? raw.issues : [], settings)
  const baselines = migrateBaselines(Array.isArray(raw.baselines) ? raw.baselines : [])

  const state: AppState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    devices,
    settings,
    issues,
    scenarios: Array.isArray(raw.scenarios) ? (raw.scenarios as AppState['scenarios']) : [],
    baselines,
    comments: Array.isArray(raw.comments) ? (raw.comments as AppState['comments']) : [],
    audit: Array.isArray(raw.audit) ? (raw.audit as AppState['audit']) : [],
    drafts: Array.isArray(raw.drafts) ? (raw.drafts as AppState['drafts']) : [],
    validationBatches: Array.isArray(raw.validationBatches)
      ? (raw.validationBatches as AppState['validationBatches'])
      : [],
    relaySnapshots: Array.isArray(raw.relaySnapshots)
      ? (raw.relaySnapshots as RelaySnapshotEntry[])
      : buildInitialRelaySnapshots(devices, settings),
    notices: [],
    activeBaselineId:
      typeof raw.activeBaselineId === 'string'
        ? (raw.activeBaselineId as string)
        : baselines.find((baseline) => baseline.status === 'locked')?.id,
  }

  return state
}

export function appendRelaySnapshot(
  snapshots: RelaySnapshotEntry[],
  entry: RelaySnapshotEntry,
): RelaySnapshotEntry[] {
  return [...snapshots, entry]
}
