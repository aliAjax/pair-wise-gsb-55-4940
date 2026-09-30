export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'reviewing' | 'approved' | 'locked' | 'returned'

/** 定值编辑中可发生冲突的字段（版本号、时间戳等元数据不参与冲突比对） */
export type SettingEditableField =
  | 'protectedDeviceId'
  | 'stage'
  | 'currentA'
  | 'timeS'
  | 'direction'
  | 'sensitivity'
  | 'recloseEnabled'
  | 'recloseDelayS'
  | 'startCondition'

export interface ConflictField {
  field: SettingEditableField
  /** 先保存一方已落库的值 */
  serverValue: string | number | boolean
  /** 晚到提交草稿中的值 */
  draftValue: string | number | boolean
  /** 编辑开始时冻结的基准值 */
  baseValue: string | number | boolean
}

export interface Device {
  id: string
  code: string
  name: string
  kind: DeviceKind
  station: string
  voltage: number
  parentId?: string
  status: DeviceStatus
  operationModes: string[]
  /** 设备记录版本，任一属性保存成功后递增，用于乐观并发控制 */
  version: number
}

export interface ProtectionSetting {
  id: string
  relayId: string
  protectedDeviceId: string
  stage: 'I' | 'II' | 'III'
  currentA: number
  timeS: number
  direction: 'forward' | 'reverse' | 'non-directional'
  sensitivity: number
  recloseEnabled: boolean
  recloseDelayS: number
  startCondition: string
  updatedAt: string
  /** 定值版本，保存成功后递增；编辑开始时冻结，保存时做乐观锁校验 */
  version: number
}

/** 晚到提交（乐观锁冲突）时保留下来的草稿，不覆盖先保存的定值 */
export interface SettingDraft {
  id: string
  settingId: string
  relayId: string
  /** 编辑开始时冻结的定值版本 */
  baseVersion: number
  /** 草稿提交时服务器上的最新版本（即先保存一方的版本） */
  serverVersion: number
  /** 草稿内容（晚到提交的完整定值） */
  payload: ProtectionSetting
  /** 与服务器版本逐字段比对后仍冲突的字段 */
  conflicts: ConflictField[]
  createdAt: string
  /** 处理状态：待处理 / 已采纳覆盖 / 已放弃 */
  status: 'pending' | 'merged' | 'discarded'
}

export type IssueValidity = 'current' | 'stale'

export interface ValidationIssue {
  id: string
  type: IssueType
  level: IssueLevel
  deviceIds: string[]
  settingIds: string[]
  message: string
  suggestion: string
  pairLabel: string
  status: 'open' | 'replying' | 'closed'
  createdAt: string
  /** 结论有效性：current 基于当前定值版本，stale 因定值版本变化而失效待重算 */
  validity: IssueValidity
  /** 结论所依据的定值版本指纹（settingId -> version） */
  basis: Record<string, number>
  /** 失效时间，重算后问题若仍存在会重建为 current 记录 */
  staleAt?: string
}

export interface ScenarioStep {
  sequence: number
  relayId: string
  action: string
  delayMs: number
  status: 'executed' | 'pending' | 'skipped'
}

export interface FaultScenario {
  id: string
  name: string
  operationMode: string
  faultDeviceId: string
  faultType: string
  status: ReviewStatus
  steps: ScenarioStep[]
  outageDevices: string[]
  createdAt: string
  notes: string
}

export interface BaselineVersion {
  id: string
  version: string
  status: ReviewStatus
  createdAt: string
  lockedAt?: string
  createdBy: string
  note: string
  snapshot: ProtectionSetting[]
  /** 快照定值对应的版本指纹，锁定时与当前版本核对 */
  settingVersions: Record<string, number>
  checksum: string
  /** 锁定时一并冻结的已确认（关闭）问题，未确认问题不得进入基线 */
  confirmedIssues?: ValidationIssue[]
}

export interface ReviewComment {
  id: string
  targetType: 'issue' | 'baseline' | 'scenario'
  targetId: string
  author: string
  content: string
  createdAt: string
  status: 'open' | 'resolved'
}

export interface AuditEntry {
  id: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

/** 持久化批次：写入前保存的上一整份状态，写入中断后据此回滚恢复 */
export interface PendingBatch {
  batchId: string
  /** 触发该批次的业务动作说明 */
  reason: string
  /** 写入前的完整状态快照（原批次） */
  backup: AppState
  /** 该批次试图写入的新状态 */
  attempted: AppState
  createdAt: string
}

/** 写入失败恢复 / 旧数据迁移后，重开时展示给用户的影响说明 */
export interface RecoveryNotice {
  id: string
  kind: 'rollback' | 'migration'
  reason: string
  restoredAt: string
  affectedSettings: Array<{ settingId: string; relayId: string; label: string }>
  affectedIssues: Array<{ issueId: string; pairLabel: string; message: string }>
  detail: string
}

export interface AppState {
  /** 数据结构版本，旧数据缺省时迁移一次 */
  schemaVersion: number
  devices: Device[]
  settings: ProtectionSetting[]
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  activeBaselineId?: string
  /** 乐观锁冲突后保留的晚到草稿 */
  settingDrafts: SettingDraft[]
  /** 未完成的写入批次；下次加载时若仍存在说明上次写入中断 */
  pendingBatch?: PendingBatch
  /** 最近一次恢复 / 迁移的影响说明，重开后仍可查看并手动关闭 */
  recoveryNotices: RecoveryNotice[]
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting
  before: string | number | boolean
  after: string | number | boolean
}

/** saveSetting 的返回结果：成功或乐观锁冲突（冲突时草稿已保留） */
export interface SaveSettingResult {
  outcome: 'saved' | 'conflict'
  setting: ProtectionSetting
  conflicts?: ConflictField[]
  serverVersion?: number
  draftId?: string
}
