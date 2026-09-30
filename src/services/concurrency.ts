import type {
  AppState,
  ConflictField,
  Device,
  ProtectionSetting,
  ValidationBatch,
  ValidationIssue,
} from '@/types/domain'

const SETTING_FIELDS: (keyof ProtectionSetting)[] = [
  'stage',
  'protectedDeviceId',
  'currentA',
  'timeS',
  'direction',
  'sensitivity',
  'recloseEnabled',
  'recloseDelayS',
  'startCondition',
]

export const VALUE_LABELS: Record<string, string> = {
  stage: '段位',
  protectedDeviceId: '保护对象',
  currentA: '电流定值',
  timeS: '动作时限',
  direction: '方向',
  sensitivity: '灵敏度',
  recloseEnabled: '重合闸投入',
  recloseDelayS: '重合延迟',
  startCondition: '启动条件',
}

export function fieldLabel(field: keyof ProtectionSetting): string {
  return VALUE_LABELS[field] ?? field
}

/** 对比打开编辑时的基准值与服务器现值、草稿值，列出真正冲突的字段 */
export function computeConflictFields(
  draft: ProtectionSetting,
  base: ProtectionSetting | null,
  server: ProtectionSetting | null,
): ConflictField[] {
  const conflicts: ConflictField[] = []
  SETTING_FIELDS.forEach((field) => {
    const baseValue = base ? base[field] : null
    const serverValue = server ? server[field] : null
    const draftValue = draft[field]
    // 服务器值相对编辑基准发生变化，且草稿值不是服务器现值，才算冲突
    if (JSON.stringify(serverValue) !== JSON.stringify(baseValue) &&
        JSON.stringify(draftValue) !== JSON.stringify(serverValue)) {
      conflicts.push({ field, base: baseValue, server: serverValue, draft: draftValue })
    }
  })
  return conflicts
}

export function currentRelayVersion(devices: Device[], relayId: string): number {
  return devices.find((device) => device.id === relayId)?.version ?? 1
}

/** 定值涉及的全部装置版本（用于给校验结论打版本基线） */
export function collectRelayVersions(
  settings: ProtectionSetting[],
  devices: Device[],
): Record<string, number> {
  const versions: Record<string, number> = {}
  new Set(settings.map((setting) => setting.relayId)).forEach((relayId) => {
    versions[relayId] = currentRelayVersion(devices, relayId)
  })
  return versions
}

/** 装置版本变化后，判定哪些历史校验结论失效 */
export function markStaleIssues(
  issues: ValidationIssue[],
  devices: Device[],
): ValidationIssue[] {
  return issues.map((issue) => {
    if (issue.stale || !issue.baseVersions) return issue
    const changed = Object.entries(issue.baseVersions).some(
      ([relayId, version]) => currentRelayVersion(devices, relayId) !== version,
    )
    return changed
      ? {
          ...issue,
          stale: true,
          // 失效问题自动回到待处理，旧的“已关闭/回复中”结论不再有效
          status: 'open',
        }
      : issue
  })
}

/** 失效问题关联的定值 id（重开后用于定位受影响定值） */
export function staleIssueSettingIds(issues: ValidationIssue[]): Set<string> {
  const ids = new Set<string>()
  issues
    .filter((issue) => issue.stale)
    .forEach((issue) => issue.settingIds.forEach((id) => ids.add(id)))
  return ids
}

/** 只有未失效问题才允许确认；未确认问题不能随旧结论锁进基线 */
export function unconfirmedBlockingIssues(
  state: AppState,
): ValidationIssue[] {
  return state.issues.filter(
    (issue) => issue.level === 'high' && (issue.stale || issue.status !== 'closed'),
  )
}

export function isIssueConfirmed(issue: ValidationIssue): boolean {
  return !issue.stale && issue.status === 'closed'
}

/** 校验批次完整性：批次必须覆盖全部装置，且问题列表与批次登记一致 */
export function isBatchIntact(
  batch: ValidationBatch,
  devices: Device[],
  issues: ValidationIssue[],
): boolean {
  const relays = devices.filter((device) => device.kind === 'relay')
  const coversAllRelays = relays.every(
    (relay) => batch.relayVersions[relay.id] === relay.version,
  )
  if (!coversAllRelays) return false
  const issueIds = new Set(issues.filter((issue) => issue.batchId === batch.id).map((i) => i.id))
  return (
    issueIds.size === batch.issueIds.length &&
    batch.issueIds.every((id) => issueIds.has(id))
  )
}

/** 定值内容指纹，供写入失败时比对原批次是否被外部改动 */
export function settingFingerprint(setting: ProtectionSetting): string {
  return SETTING_FIELDS.map((field) => `${field}=${JSON.stringify(setting[field])}`).join(';')
}
