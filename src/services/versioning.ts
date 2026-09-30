import type {
  ConflictField,
  Device,
  ProtectionSetting,
  SettingEditableField,
  ValidationIssue,
} from '@/types/domain'
import { validateSettings } from './validation'

/** 定值的全部业务字段（version / updatedAt 等元数据除外），用于逐字段冲突比对 */
export const SETTING_VALUE_FIELDS: SettingEditableField[] = [
  'protectedDeviceId',
  'stage',
  'currentA',
  'timeS',
  'direction',
  'sensitivity',
  'recloseEnabled',
  'recloseDelayS',
  'startCondition',
]

/** 计算一组定值的版本指纹：settingId -> version */
export function versionBasis(settings: ProtectionSetting[]): Record<string, number> {
  const basis: Record<string, number> = {}
  settings.forEach((setting) => {
    basis[setting.id] = setting.version
  })
  return basis
}

/**
 * 逐字段比对晚到提交草稿与服务器最新定值。
 * 仅当草稿值与服务器值不同，且服务器值相对编辑基准也发生变化时，才算真正冲突；
 * 若先保存一方未改动该字段（草稿单方修改），保存时会由服务端按常规处理，这里不列冲突。
 */
export function diffConflicts(
  draft: ProtectionSetting,
  server: ProtectionSetting,
  base: ProtectionSetting,
): ConflictField[] {
  const conflicts: ConflictField[] = []
  SETTING_VALUE_FIELDS.forEach((field) => {
    if (draft[field] === server[field]) return
    if (server[field] === base[field]) return
    conflicts.push({
      field,
      serverValue: server[field],
      draftValue: draft[field],
      baseValue: base[field],
    })
  })
  return conflicts
}

/** 判断问题依据的定值版本是否与当前版本一致 */
export function isIssueCurrent(
  issue: ValidationIssue,
  settingsById: Map<string, ProtectionSetting>,
): boolean {
  // 结论引用的定值已被删除，也视为失效
  return Object.entries(issue.basis).every(([settingId, version]) => {
    const current = settingsById.get(settingId)
    return current ? current.version === version : false
  })
}

/**
 * 定值版本变化后，将受影响的校验问题标记为 stale（保留旧结论但不再有效）。
 * 只标记 basis 中引用了发生版本变化（或被删除）定值的问题。
 */
export function invalidateAffectedIssues(
  issues: ValidationIssue[],
  previousSettings: ProtectionSetting[],
  nextSettings: ProtectionSetting[],
): ValidationIssue[] {
  const previousById = new Map(previousSettings.map((item) => [item.id, item]))
  const nextById = new Map(nextSettings.map((item) => [item.id, item]))
  const changedIds = new Set<string>()
  previousById.forEach((previous, id) => {
    const next = nextById.get(id)
    if (!next || next.version !== previous.version) changedIds.add(id)
  })
  const staleAt = new Date().toISOString()
  return issues.map((issue) => {
    if (issue.validity === 'stale') return issue
    const touched = Object.keys(issue.basis).some((settingId) => changedIds.has(settingId))
    return touched ? { ...issue, validity: 'stale' as const, staleAt } : issue
  })
}

export interface ReconcileResult {
  issues: ValidationIssue[]
  /** 本次重算新建的问题（旧结论中不存在或已失效） */
  recomputed: ValidationIssue[]
  /** 被新结论取代而移除的失效问题 id */
  droppedStaleIds: string[]
}

/**
 * 基于当前定值重新执行校验，并与已有问题对账：
 * - 当前仍存在且依据版本为最新的问题，保留处理状态（回复中 / 已关闭）；
 * - 失效（stale）问题若规则不再命中，则随旧结论淘汰；
 * - 规则命中但无现存 current 结论的，作为新问题（current）生成；
 * - 已关闭问题若在新版本上再次命中，重新打开为 current 的新结论。
 */
export function reconcileIssues(
  previous: ValidationIssue[],
  settings: ProtectionSetting[],
  devices: Device[],
): ReconcileResult {
  const settingsById = new Map(settings.map((item) => [item.id, item]))
  const fresh = validateSettings(settings, devices)
  const basis = versionBasis(settings)
  const now = new Date().toISOString()

  const result: ValidationIssue[] = []
  const consumedFresh = new Set<string>()

  previous.forEach((issue) => {
    const stillHit = fresh.find((item) => item.id === issue.id)
    const current = isIssueCurrent(issue, settingsById)
    if (current) {
      if (stillHit) consumedFresh.add(issue.id)
      // 依据仍是当前版本：规则不再命中则自然移除
      if (stillHit) result.push({ ...issue, validity: 'current' as const })
      return
    }
    // 失效问题：新版本仍命中则由新结论取代（旧结论淘汰，新结论重建）
    if (stillHit) consumedFresh.add(issue.id)
  })

  const recomputed: ValidationIssue[] = fresh
    .filter((item) => !consumedFresh.has(item.id))
    .map((item) => ({
      ...item,
      status: 'open' as const,
      validity: 'current' as const,
      basis,
      createdAt: now,
    }))

  result.push(...recomputed)

  const droppedStaleIds = previous
    .filter((issue) => issue.validity === 'stale')
    .filter((issue) => !result.some((item) => item.id === issue.id))
    .map((issue) => issue.id)

  return { issues: result, recomputed, droppedStaleIds }
}
