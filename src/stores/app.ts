import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  Device,
  ProtectionSetting,
  RecoveryNotice,
  ReviewComment,
  ReviewStatus,
  SaveSettingResult,
  SettingDraft,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import {
  invalidateAffectedIssues,
  reconcileIssues,
  diffConflicts,
  versionBasis,
} from '@/services/versioning'
import { persistState, armWriteFailure } from '@/api/client'
import { loadState } from '@/services/storage'

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const now = () => new Date().toISOString()

function checksum(settings: ProtectionSetting[]): string {
  const source = settings
    .map((item) => `${item.id}:${item.currentA}:${item.timeS}:${item.recloseDelayS}`)
    .join('|')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return value.toString(16).toUpperCase().padStart(8, '0').match(/.{4}/g)?.join('-') ?? '0000-0000'
}

export class ConcurrencyConflictError extends Error {
  conflicts: SaveSettingResult['conflicts']
  serverVersion: number
  draftId: string
  constructor(message: string, conflicts: SaveSettingResult['conflicts'], serverVersion: number, draftId: string) {
    super(message)
    this.name = 'ConcurrencyConflictError'
    this.conflicts = conflicts
    this.serverVersion = serverVersion
    this.draftId = draftId
  }
}

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const drafts = computed(() => data.value.settingDrafts)
  const recoveryNotices = computed(() => data.value.recoveryNotices)
  const staleIssues = computed(() => data.value.issues.filter((issue) => issue.validity === 'stale'))
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )

  function hydrate(state: AppState) {
    data.value = state
    hydrated.value = true
  }

  /**
   * 以「批次」方式提交：写入前内存状态即为待写入状态，
   * persistState 内部走两阶段写入。若写入失败，
   * 用持久化层从原批次恢复出的状态覆盖内存，保证不留半套结果。
   */
  async function commit(message: string, reason: string) {
    saving.value = true
    const before = JSON.parse(JSON.stringify(data.value)) as AppState
    try {
      const saved = await persistState(
        JSON.parse(JSON.stringify(data.value)) as AppState,
        reason,
      )
      data.value = saved
      lastMessage.value = message
    } catch (error) {
      // 写入失败：从持久化层重新加载原批次（日志回滚后的状态）
      try {
        data.value = loadState()
      } catch {
        data.value = before
      }
      throw error
    } finally {
      saving.value = false
    }
  }

  function appendAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
    data.value.audit.unshift({
      ...entry,
      id: createId('audit'),
      createdAt: now(),
    })
  }

  async function addDevice(device: Omit<Device, 'id' | 'version'>) {
    const item: Device = { ...device, id: createId('device'), version: 1 }
    data.value.devices.push(item)
    appendAudit({
      action: '新增设备',
      target: item.name,
      operator: '当前用户',
      detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV。`,
    })
    await commit(`已新增 ${item.name}`, `新增设备 ${item.name}`)
    return item
  }

  async function updateDevice(device: Device) {
    const index = data.value.devices.findIndex((item) => item.id === device.id)
    if (index < 0) return
    const current = data.value.devices[index]
    // 保存前冻结的设备版本与服务器版本不一致：拒绝覆盖，由调用方提示刷新
    if (device.version !== current.version) {
      throw new ConcurrencyConflictError(
        `设备 ${device.name} 已被其他终端保存（版本 V${current.version}），请刷新后重新编辑。`,
        [],
        current.version,
        '',
      )
    }
    data.value.devices[index] = {
      ...device,
      operationModes: [...device.operationModes],
      version: current.version + 1,
    }
    appendAudit({
      action: '更新设备',
      target: device.name,
      operator: '当前用户',
      detail: `运行状态调整为 ${device.status}，版本递增至 V${current.version + 1}。`,
    })
    await commit(`已更新 ${device.name}`, `更新设备 ${device.name}`)
  }

  /**
   * 保存定值（乐观锁）：
   * - base 为编辑开始时冻结的定值（携带冻结版本号）；
   * - 服务器版本晚于冻结版本，说明已有其他终端先保存：本次提交整体拒绝，
   *   草稿原样保留到 settingDrafts 并列出双方都改过的冲突字段；
   * - 服务器版本未变：正常保存，版本 +1，关联校验问题随即失效。
   */
  async function saveSetting(
    incoming: ProtectionSetting,
    base: ProtectionSetting,
  ): Promise<SaveSettingResult> {
    const index = data.value.settings.findIndex((item) => item.id === incoming.id)
    const current = index >= 0 ? data.value.settings[index] : undefined

    if (current && base.version !== current.version) {
      const conflicts = diffConflicts(incoming, current, base)
      const draft: SettingDraft = {
        id: createId('draft'),
        settingId: incoming.id,
        relayId: incoming.relayId,
        baseVersion: base.version,
        serverVersion: current.version,
        payload: { ...incoming },
        conflicts,
        createdAt: now(),
        status: 'pending',
      }
      data.value.settingDrafts.unshift(draft)
      appendAudit({
        action: '保存冲突-保留草稿',
        target: `${incoming.relayId} ${incoming.stage} 段`,
        operator: '当前用户',
        detail:
          `编辑基于 V${base.version}，服务器已到 V${current.version}；` +
          `${conflicts.length} 个字段存在冲突，晚到提交已保留为草稿，未覆盖先保存内容。`,
      })
      await commit('检测到并发冲突，草稿已保留', `定值冲突保留草稿 ${incoming.id}`)
      return {
        outcome: 'conflict',
        setting: current,
        conflicts,
        serverVersion: current.version,
        draftId: draft.id,
      }
    }

    const previousSettings = JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[]
    const nextVersion = current ? current.version + 1 : 1
    const persisted: ProtectionSetting = { ...incoming, updatedAt: now(), version: nextVersion }
    if (index >= 0) data.value.settings[index] = persisted
    else data.value.settings.push(persisted)

    // 版本变化后，引用该定值的校验问题结论失效，立即按新版本重算
    data.value.issues = invalidateAffectedIssues(
      data.value.issues,
      previousSettings,
      data.value.settings,
    )
    const reconciled = reconcileIssues(data.value.issues, data.value.settings, data.value.devices)
    data.value.issues = reconciled.issues

    appendAudit({
      action: index >= 0 ? '修改定值' : '新增定值',
      target: `${incoming.relayId} ${incoming.stage} 段`,
      operator: '当前用户',
      detail:
        `电流 ${incoming.currentA}A，时限 ${incoming.timeS}s，版本 V${nextVersion}。` +
        (reconciled.recomputed.length
          ? `重算新增 ${reconciled.recomputed.length} 条校验问题。`
          : ''),
    })
    await commit('定值已保存', commitReason(incoming, index >= 0))
    return { outcome: 'saved', setting: persisted }
  }

  /** 采纳冲突草稿：以草稿内容覆盖保存，版本在服务器最新版本上继续递增 */
  async function mergeDraft(draftId: string) {
    const draftIndex = data.value.settingDrafts.findIndex((item) => item.id === draftId)
    if (draftIndex < 0) return
    const draft = data.value.settingDrafts[draftIndex]
    const current = data.value.settings.find((item) => item.id === draft.settingId)
    if (!current) {
      // 定值已被删除：放弃草稿
      data.value.settingDrafts.splice(draftIndex, 1)
      return
    }
    const previousSettings = JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[]
    const next: ProtectionSetting = {
      ...draft.payload,
      id: current.id,
      updatedAt: now(),
      version: current.version + 1,
    }
    const index = data.value.settings.findIndex((item) => item.id === current.id)
    data.value.settings[index] = next
    data.value.settingDrafts[draftIndex] = { ...draft, status: 'merged' }
    data.value.issues = invalidateAffectedIssues(
      data.value.issues,
      previousSettings,
      data.value.settings,
    )
    data.value.issues = reconcileIssues(data.value.issues, data.value.settings, data.value.devices).issues
    appendAudit({
      action: '采纳冲突草稿',
      target: `${next.relayId} ${next.stage} 段`,
      operator: '当前用户',
      detail: `基于 V${draft.serverVersion} 采纳晚到草稿，版本递增至 V${next.version}。`,
    })
    await commit('冲突草稿已采纳', `采纳定值草稿 ${next.id}`)
  }

  async function discardDraft(draftId: string) {
    const draft = data.value.settingDrafts.find((item) => item.id === draftId)
    if (!draft) return
    draft.status = 'discarded'
    appendAudit({
      action: '放弃冲突草稿',
      target: draft.settingId,
      operator: '当前用户',
      detail: `晚到提交草稿（基于 V${draft.baseVersion}）已放弃。`,
    })
    await commit('草稿已放弃', `放弃定值草稿 ${draft.settingId}`)
  }

  /** 批量校验：以当前定值版本重算并与既有结论对账；问题版本依据在重算时刷新 */
  async function runValidation() {
    const { issues } = reconcileIssues(data.value.issues, data.value.settings, data.value.devices)
    data.value.issues = issues
    const staleCount = issues.filter((issue) => issue.validity === 'stale').length
    const openCount = issues.filter((issue) => issue.status !== 'closed').length
    appendAudit({
      action: '批量校验',
      target: '全部保护定值',
      operator: '当前用户',
      detail: `重算后 ${openCount} 条待处理问题，${staleCount} 条历史结论已失效。`,
    })
    await commit('批量校验完成', '批量校验')
    return data.value.issues
  }

  /** 仅允许更新当前仍有效的问题；失效问题必须重算后再处理 */
  async function updateIssue(issue: ValidationIssue) {
    const index = data.value.issues.findIndex((item) => item.id === issue.id)
    if (index < 0) return
    if (issue.validity === 'stale') {
      throw new Error('该校验问题依据的定值版本已变化，结论失效，请重新校验后再处理。')
    }
    data.value.issues[index] = issue
    appendAudit({
      action: '更新问题状态',
      target: issue.pairLabel,
      operator: '当前用户',
      detail: `状态更新为 ${issue.status}。`,
    })
    await commit('问题状态已更新', `更新问题 ${issue.pairLabel}`)
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    data.value.comments.unshift({
      ...comment,
      id: createId('comment'),
      createdAt: now(),
    })
    appendAudit({
      action: '提交会签意见',
      target: comment.targetId,
      operator: comment.author,
      detail: comment.content,
    })
    await commit('意见已提交', `会签意见 ${comment.targetId}`)
  }

  async function updateScenarioStatus(id: string, status: ReviewStatus) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) return
    scenario.status = status
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: '当前用户',
      detail: `状态更新为 ${status}。`,
    })
    await commit('场景状态已更新', `场景流转 ${scenario.name}`)
  }

  async function addScenario(
    scenario: Omit<AppState['scenarios'][number], 'id' | 'createdAt' | 'steps' | 'status'>,
  ) {
    const item = {
      ...scenario,
      id: createId('scenario'),
      status: 'draft' as const,
      steps: [],
      createdAt: now(),
    }
    data.value.scenarios.unshift(item)
    appendAudit({
      action: '新增故障场景',
      target: item.name,
      operator: '当前用户',
      detail: `运行方式：${item.operationMode}，故障类型：${item.faultType}。`,
    })
    await commit('故障场景已创建', `新增场景 ${item.name}`)
    return item
  }

  async function createBaseline(note: string) {
    const nextNumber = data.value.baselines.length + 1
    const snapshot = JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[]
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'reviewing',
      createdAt: now(),
      createdBy: '当前用户',
      note,
      snapshot,
      settingVersions: versionBasis(snapshot),
      checksum: checksum(snapshot),
    }
    data.value.baselines.unshift(baseline)
    appendAudit({
      action: '创建基线上会签',
      target: baseline.version,
      operator: '当前用户',
      detail: note,
    })
    await commit('基线已创建并提交会签', `创建基线 ${baseline.version}`)
    return baseline
  }

  async function approveBaseline(id: string) {
    const baseline = data.value.baselines.find((item) => item.id === id)
    if (!baseline) return

    // 1) 快照创建后定值版本又发生变化：旧结论不能锁进基线，需重新创建快照
    const drifted = data.value.settings.some((setting) => {
      const snapVersion = baseline.settingVersions[setting.id]
      return snapVersion === undefined || snapVersion !== setting.version
    })
    if (drifted) {
      throw new Error('定值版本相对基线快照已变化，请重新创建基线后再锁定。')
    }

    // 2) 存在失效（未重算确认）的问题：不能随旧结论锁进基线
    const stale = data.value.issues.filter((issue) => issue.validity === 'stale')
    if (stale.length) {
      throw new Error(`有 ${stale.length} 条校验问题因定值版本变化已失效，请重新校验确认后再锁定。`)
    }

    // 3) 未关闭（未确认）问题不得进入基线
    const open = data.value.issues.filter((issue) => issue.status !== 'closed')
    if (open.some((issue) => issue.level === 'high')) {
      throw new Error('存在未关闭的高风险问题，不能锁定基线')
    }
    if (open.length) {
      throw new Error(`仍有 ${open.length} 条未确认问题，不能锁定基线。`)
    }

    baseline.status = 'locked'
    baseline.lockedAt = now()
    // 冻结锁定时刻已确认（关闭且仍有效）的问题快照
    baseline.confirmedIssues = data.value.issues
      .filter((issue) => issue.status === 'closed' && issue.validity === 'current')
      .map((issue) => ({ ...issue }))
    data.value.activeBaselineId = baseline.id
    appendAudit({
      action: '锁定基线',
      target: baseline.version,
      operator: '当前用户',
      detail: `校验码 ${baseline.checksum}，冻结 ${baseline.confirmedIssues.length} 条已确认问题。`,
    })
    await commit('基线已锁定', `锁定基线 ${baseline.version}`)
  }

  async function dismissRecoveryNotice(id: string) {
    data.value.recoveryNotices = data.value.recoveryNotices.filter((item) => item.id !== id)
    await persistState(
      JSON.parse(JSON.stringify(data.value)) as AppState,
      '关闭恢复提示',
    ).then((state) => {
      data.value = state
    })
  }

  function latestRecoveryNotice(): RecoveryNotice | undefined {
    return data.value.recoveryNotices[0]
  }

  async function recordExport(format: string, count: number) {
    appendAudit({
      action: '导出定值清单',
      target: `${format} 文件`,
      operator: '当前用户',
      detail: `导出 ${count} 条保护定值。`,
    })
    await commit('导出记录已写入审计', '导出定值清单')
  }

  async function reset() {
    data.value = createInitialState()
    await commit('已恢复演示数据', '恢复演示数据')
  }

  /**
   * 演练：让下一次批次写入在主状态落盘前失败。
   * 失败后内存立即从原批次恢复，重开页面仍可看到受影响定值与问题的恢复说明。
   */
  async function demoWriteFailure() {
    await armWriteFailure()
    appendAudit({
      action: '写入中断演练',
      target: '本地持久化',
      operator: '当前用户',
      detail: '下一次写入被设置为失败，用于验证批次回滚恢复。',
    })
    try {
      await commit('演练写入（预期失败）', '写入中断演练')
    } catch {
      // 预期失败：commit 已完成从原批次恢复，这里抛出供调用方提示。
      throw new Error('写入已按预期失败，系统已从原批次恢复')
    }
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    devices,
    settings,
    issues,
    scenarios,
    drafts,
    recoveryNotices,
    staleIssues,
    activeBaseline,
    hydrate,
    addDevice,
    updateDevice,
    saveSetting,
    mergeDraft,
    discardDraft,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    addScenario,
    createBaseline,
    approveBaseline,
    dismissRecoveryNotice,
    latestRecoveryNotice,
    recordExport,
    reset,
    demoWriteFailure,
  }
})

function commitReason(setting: ProtectionSetting, exists: boolean): string {
  return `${exists ? '修改' : '新增'}定值 ${setting.relayId} ${setting.stage} 段`
}
