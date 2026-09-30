export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'reviewing' | 'approved' | 'locked' | 'returned'

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
  /** 装置级乐观锁版本：其定值每成功保存一次递增；旧数据迁移时补 1 */
  version: number
  /** 版本最近一次变化时间 */
  versionUpdatedAt?: string
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
}

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
  /** 结论所基于的各装置版本；任一装置版本变化即失效 */
  baseVersions?: Record<string, number>
  /** 所属校验批次 */
  batchId?: string
  /** 装置版本变化后置为失效，需要重新批量校验 */
  stale?: boolean
}

/** 晚到提交保留下来的草稿与服务器现值之间的字段冲突 */
export interface ConflictField {
  field: keyof ProtectionSetting
  base: string | number | boolean | null
  server: string | number | boolean | null
  draft: string | number | boolean | null
}

/** 乐观锁冲突时保留的定值草稿 */
export interface SettingDraft {
  id: string
  relayId: string
  settingId: string
  setting: ProtectionSetting
  /** 打开编辑时的装置现值；新增定值时为 null */
  baseSetting: ProtectionSetting | null
  /** 草稿依据的装置版本 */
  expectedRelayVersion: number
  conflictFields: ConflictField[]
  status: 'conflict'
  createdAt: string
  updatedAt: string
}

/** 校验批次：只有完整跑完才会落库，中断不留半成品 */
export interface ValidationBatch {
  id: string
  startedAt: string
  finishedAt: string
  /** 批次覆盖的各装置版本 */
  relayVersions: Record<string, number>
  issueIds: string[]
}

/** 装置版本初始快照（旧数据迁移时补建） */
export interface RelaySnapshotEntry {
  relayId: string
  version: number
  at: string
  settingIds: string[]
}

/** 迁移或写入失败恢复后给用户的留痕，重开仍可查看受影响定值与问题 */
export interface SystemNotice {
  id: string
  kind: 'migration' | 'recovery'
  title: string
  detail: string
  at: string
  relayIds: string[]
  settingIds: string[]
  issueIds: string[]
  dismissed: boolean
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
  checksum: string
  /** 创建快照时各装置版本 */
  relayVersions: Record<string, number>
  /** 锁定时对应的校验批次 */
  validationBatchId?: string
  /** 锁定时一并冻结的、已确认（已关闭且未失效）的问题结论 */
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

export interface AppState {
  schemaVersion: number
  devices: Device[]
  settings: ProtectionSetting[]
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  drafts: SettingDraft[]
  validationBatches: ValidationBatch[]
  relaySnapshots: RelaySnapshotEntry[]
  notices: SystemNotice[]
  activeBaselineId?: string
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting
  before: string | number | boolean
  after: string | number | boolean
}
