import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  Device,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  SettingDraft,
  SystemNotice,
  ValidationBatch,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import {
  collectRelayVersions,
  computeConflictFields,
  markStaleIssues,
  unconfirmedBlockingIssues,
} from '@/services/concurrency'
import { recomputeIssues } from '@/services/validation'
import { persistNotices, persistState, RevisionConflictError } from '@/api/client'
import { resetState, saveNotices } from '@/services/storage'

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const now = () => new Date().toISOString()

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

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

export type SaveSettingOutcome =
  | { outcome: 'saved'; setting: ProtectionSetting }
  | { outcome: 'conflict'; draft: SettingDraft }

let validationSeq = 0
const validationCancels = new Map<number, () => void>()

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const revision = ref(0)
  const hydrated = ref(false)
  const saving = ref(false)
  const validating = ref(false)
  const lastMessage = ref('')

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const drafts = computed(() => data.value.drafts)
  const notices = computed(() => data.value.notices)
  const validationBatches = computed(() => data.value.validationBatches)
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )
  const staleIssues = computed(() => data.value.issues.filter((issue) => issue.stale))
  const blockingIssues = computed(() => unconfirmedBlockingIssues(data.value))

  function hydrate(envelope: { state: AppState; revision: number }) {
    data.value = envelope.state
    revision.value = envelope.revision
    hydrated.value = true
  }

  function appendAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
    data.value.audit.unshift({
      ...entry,
      id: createId('audit'),
      createdAt: now(),
    })
  }

  function persistNoticesLocal(entries: SystemNotice[]) {
    // 通知独立落盘：即使主批次写入失败，恢复记录仍保留，重开可见
    saveNotices(entries)
  }

  function addNotice(notice: Omit<SystemNotice, 'id' | 'at' | 'dismissed'>) {
    const entry: SystemNotice = {
      ...notice,
      id: createId('notice'),
      at: now(),
      dismissed: false,
    }
    data.value.notices.unshift(entry)
    persistNoticesLocal(data.value.notices)
    return entry
  }

  /**
   * 以事务方式应用变更：
   * - 成功：按新修订号整体落库；
   * - 409（版本被他端推进）：还原内存到提交前，抛出 RevisionConflictError；
   * - 写入失败：还原内存到提交前（原批次恢复），登记恢复通知后抛出。
   */
  async function transact<T>(
    mutate: () => T,
    options: {
      message?: string
      recovery?: {
        title: string
        collect: () => { relayIds: string[]; settingIds: string[]; issueIds: string[] }
      }
    } = {},
  ): Promise<T> {
    const snapshot = clone(data.value)
    const expected = revision.value
    saving.value = true
    let result: T
    try {
      result = mutate()
    } catch (error) {
      // mutate 自身异常（含主动版本检查）：不写库，还原到原批次
      data.value = snapshot
      saving.value = false
      throw error
    }
    try {
      const envelope = await persistState(clone(data.value), expected)
      data.value = envelope.state
      revision.value = envelope.revision
      if (options.message) lastMessage.value = options.message
      return result
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        // 后到提交不能盖掉先到版本：
        // 先撤销 mutate 已施加的本地改动，再以服务端真值为准（草稿由上层在干净状态上保留）
        data.value = clone(snapshot)
        data.value = error.serverEnvelope.state
        revision.value = error.serverEnvelope.revision
        throw error
      }
      // 写入失败：从原批次完整恢复，不留半套结果
      data.value = snapshot
      revision.value = expected
      if (options.recovery) {
        const affected = options.recovery.collect()
        addNotice({
          kind: 'recovery',
          title: options.recovery.title,
          detail:
            '写入失败，已自动回滚到写入前的原批次数据，未留下半套结果。请处理后重试，受影响的定值与问题如下。',
          relayIds: affected.relayIds,
          settingIds: affected.settingIds,
          issueIds: affected.issueIds,
        })
      }
      throw error
    } finally {
      saving.value = false
    }
  }

  async function addDevice(device: Omit<Device, 'id' | 'version'>) {
    const item: Device = { ...device, id: createId('device'), version: 1 }
    return transact(
      () => {
        data.value.devices.push(item)
        appendAudit({
          action: '新增设备',
          target: item.name,
          operator: '当前用户',
          detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV，初始版本 V1。`,
        })
        return item
      },
      { message: `已新增 ${item.name}` },
    )
  }

  async function updateDevice(device: Device) {
    const index = data.value.devices.findIndex((item) => item.id === device.id)
    if (index < 0) return
    return transact(() => {
      data.value.devices[index] = {
        ...device,
        operationModes: [...device.operationModes],
        version: data.value.devices[index].version,
      }
      appendAudit({
        action: '更新设备',
        target: device.name,
        operator: '当前用户',
        detail: `运行状态调整为 ${device.status}。`,
      })
    }, { message: `已更新 ${device.name}` })
  }

  function upsertDraft(draft: SettingDraft) {
    const index = data.value.drafts.findIndex(
      (item) => item.relayId === draft.relayId && item.settingId === draft.settingId,
    )
    if (index >= 0) data.value.drafts[index] = draft
    else data.value.drafts.unshift(draft)
  }

  /**
   * 保存定值（乐观锁）：
   * 保存前冻结装置版本 expectedRelayVersion；他端已提交则保留草稿并列出冲突字段。
   */
  async function saveSetting(
    input: ProtectionSetting,
    expectedRelayVersion: number,
    baseSetting: ProtectionSetting | null,
  ): Promise<SaveSettingOutcome> {
    const setting: ProtectionSetting = { ...input, updatedAt: now() }
    const affectedRelayIds = [setting.relayId]
    const collectAffected = () => ({
      relayIds: affectedRelayIds,
      settingIds: [setting.id],
      issueIds: data.value.issues
        .filter((issue) => issue.settingIds.includes(setting.id))
        .map((issue) => issue.id),
    })

    try {
      return await transact(
        () => {
          const relay = data.value.devices.find((device) => device.id === setting.relayId)
          // 服务端版本已被其他终端推进：不在此提交，由 catch 保留草稿
          if (!relay || relay.version !== expectedRelayVersion) {
            throw new RevisionConflictError({
              state: clone(data.value),
              revision: revision.value,
            })
          }

          const index = data.value.settings.findIndex((item) => item.id === setting.id)
          if (index >= 0) data.value.settings[index] = setting
          else data.value.settings.push(setting)

          // 冻结版本递增
          relay.version += 1
          relay.versionUpdatedAt = now()

          // 记录版本快照，重开可追溯每个版本覆盖的定值
          data.value.relaySnapshots.push({
            relayId: relay.id,
            version: relay.version,
            at: now(),
            settingIds: data.value.settings
              .filter((item) => item.relayId === relay.id)
              .map((item) => item.id),
          })

          // 版本变化后，涉及该装置的历史校验结论失效，回到待处理
          data.value.issues = markStaleIssues(data.value.issues, data.value.devices)

          appendAudit({
            action: index >= 0 ? '修改定值' : '新增定值',
            target: `${setting.relayId} ${setting.stage} 段`,
            operator: '当前用户',
            detail: `装置版本 V${expectedRelayVersion} → V${relay.version}；电流 ${setting.currentA}A，时限 ${setting.timeS}s。关联校验结论已置失效，需重新校验。`,
          })
          return { outcome: 'saved' as const, setting }
        },
        {
          message: '定值已保存，装置版本已冻结，关联校验问题待重算',
          recovery: {
            title: `定值保存失败：${setting.relayId} ${setting.stage} 段`,
            collect: collectAffected,
          },
        },
      )
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error

      // 走到这里 data.value 已是服务端现值（本地预检失配或服务端 409 后回拉）
      const serverSetting =
        data.value.settings.find((item) => item.id === setting.id) ?? null
      const conflictFields = computeConflictFields(setting, baseSetting, serverSetting)
      const serverVersion =
        data.value.devices.find((device) => device.id === setting.relayId)?.version ??
        expectedRelayVersion
      const draft: SettingDraft = {
        id: createId('draft'),
        relayId: setting.relayId,
        settingId: setting.id,
        setting,
        baseSetting,
        expectedRelayVersion: serverVersion,
        conflictFields,
        status: 'conflict',
        createdAt: now(),
        updatedAt: now(),
      }

      // 晚到提交保留为草稿、登记冲突审计，随当前修订号一次落库
      upsertDraft(draft)
      data.value.audit.unshift({
        id: createId('audit'),
        createdAt: now(),
        action: '定值保存冲突',
        target: `${setting.relayId} ${setting.stage} 段`,
        operator: '当前用户',
        detail: `装置已被其他终端更新到 V${serverVersion}，晚到提交未覆盖原值，已保留草稿并标出 ${conflictFields.length} 个冲突字段。`,
      })
      try {
        const envelope = await persistState(clone(data.value), revision.value)
        data.value = envelope.state
        revision.value = envelope.revision
      } catch {
        // 草稿落库失败时至少保留在内存中，提示用户稍后重试
      }
      return { outcome: 'conflict', draft }
    }
  }

  /**
   * 重新批量校验：完整跑完才一次性替换问题列表并登记批次，
   * 中断（页面关闭/重复触发）不会留下半套结果。
   */
  async function runValidation() {
    const seq = ++validationSeq
    validating.value = true
    const startedAt = now()
    const batchId = createId('batch')
    try {
      // 模拟校验计算过程；期间若再次触发或被取消，旧的一轮结果作废，不写库
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, 600)
        validationCancels.set(seq, () => {
          window.clearTimeout(timer)
          reject(new Error('校验被中断：本轮结果作废，未写入半成品'))
        })
      }).finally(() => validationCancels.delete(seq))
      if (seq !== validationSeq) throw new Error('校验结果已过期')

      return await transact(
        () => {
          const nextIssues = recomputeIssues(
            data.value.issues,
            data.value.settings,
            data.value.devices,
            batchId,
          )
          const batch: ValidationBatch = {
            id: batchId,
            startedAt,
            finishedAt: now(),
            relayVersions: collectRelayVersions(data.value.settings, data.value.devices),
            issueIds: nextIssues.map((issue) => issue.id),
          }
          data.value.issues = nextIssues
          data.value.validationBatches.unshift(batch)
          appendAudit({
            action: '批量校验',
            target: '全部保护定值',
            operator: '当前用户',
            detail: `批次 ${batchId.slice(-6)} 完整完成，在册 ${nextIssues.length} 条问题，全部结论基于当前装置版本。`,
          })
          return nextIssues
        },
        {
          message: '批量校验完成',
          recovery: {
            title: '批量校验结果写入失败',
            collect: () => ({
              relayIds: [...new Set(data.value.settings.map((s) => s.relayId))],
              settingIds: data.value.settings.map((s) => s.id),
              issueIds: data.value.issues.map((issue) => issue.id),
            }),
          },
        },
      )
    } finally {
      if (seq === validationSeq) validating.value = false
    }
  }

  /** 中断正在进行的校验：本轮不落库、不留半成品 */
  function cancelValidation() {
    validationCancels.forEach((cancel) => cancel())
    validationCancels.clear()
    validationSeq += 1
    validating.value = false
  }

  async function updateIssue(issue: ValidationIssue) {
    return transact(() => {
      const index = data.value.issues.findIndex((item) => item.id === issue.id)
      if (index >= 0) data.value.issues[index] = { ...issue, stale: data.value.issues[index].stale }
      appendAudit({
        action: '更新问题状态',
        target: issue.pairLabel,
        operator: '当前用户',
        detail: `状态更新为 ${issue.status}。`,
      })
    }, { message: '问题状态已更新' })
  }

  /** 处理冲突草稿：采用服务端值（放弃草稿）或以草稿为基础重新编辑 */
  async function resolveDraft(
    draftId: string,
    resolution: 'discard' | 'reopen',
    mergedSetting?: ProtectionSetting,
    mergedBase?: ProtectionSetting | null,
  ): Promise<SaveSettingOutcome | { outcome: 'discarded' }> {
    const draftIndex = data.value.drafts.findIndex((item) => item.id === draftId)
    if (draftIndex < 0) return { outcome: 'discarded' }
    const draft = data.value.drafts[draftIndex]
    const serverVersion =
      data.value.devices.find((device) => device.id === draft.relayId)?.version ??
      draft.expectedRelayVersion
    const serverSetting =
      data.value.settings.find((item) => item.id === draft.settingId) ?? null

    if (resolution === 'discard') {
      await transact(() => {
        data.value.drafts.splice(draftIndex, 1)
        appendAudit({
          action: '放弃冲突草稿',
          target: `${draft.relayId} ${draft.setting.stage} 段`,
          operator: '当前用户',
          detail: '晚到提交与他人修改冲突，已采用服务器现值，草稿作废。',
        })
      }, { message: '已采用服务器现值' })
      return { outcome: 'discarded' }
    }

    const nextSetting = mergedSetting ?? draft.setting
    const nextBase = mergedBase ?? serverSetting
    // 先移除旧草稿，再按当前版本重新走一次乐观锁保存
    data.value.drafts.splice(draftIndex, 1)
    return saveSetting(nextSetting, serverVersion, nextBase)
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    return transact(() => {
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
    }, { message: '意见已提交' })
  }

  async function updateScenarioStatus(id: string, status: ReviewStatus) {
    return transact(() => {
      const scenario = data.value.scenarios.find((item) => item.id === id)
      if (!scenario) return
      scenario.status = status
      appendAudit({
        action: '场景状态流转',
        target: scenario.name,
        operator: '当前用户',
        detail: `状态更新为 ${status}。`,
      })
    }, { message: '场景状态已更新' })
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
    return transact(() => {
      data.value.scenarios.unshift(item)
      appendAudit({
        action: '新增故障场景',
        target: item.name,
        operator: '当前用户',
        detail: `运行方式：${item.operationMode}，故障类型：${item.faultType}。`,
      })
      return item
    }, { message: '故障场景已创建' })
  }

  async function createBaseline(note: string) {
    const nextNumber = data.value.baselines.length + 1
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'reviewing',
      createdAt: now(),
      createdBy: '当前用户',
      note,
      snapshot: clone(data.value.settings),
      checksum: checksum(data.value.settings),
      relayVersions: collectRelayVersions(data.value.settings, data.value.devices),
      confirmedIssues: [],
    }
    return transact(() => {
      data.value.baselines.unshift(baseline)
      appendAudit({
        action: '创建基线上会签',
        target: baseline.version,
        operator: '当前用户',
        detail: note,
      })
      return baseline
    }, { message: '基线已创建并提交会签' })
  }

  /**
   * 锁定基线：
   * - 高风险未关闭问题、或任何失效待重算问题存在时拒绝；
   * - 只有当前版本下已确认（未失效且已关闭）的问题结论随快照冻结。
   */
  async function approveBaseline(id: string) {
    const stale = data.value.issues.filter((issue) => issue.stale)
    if (stale.length > 0) {
      throw new Error(`存在 ${stale.length} 条因装置版本变化而失效的问题，请先重新批量校验并确认`)
    }
    const blockers = data.value.issues.filter(
      (issue) => issue.level === 'high' && issue.status !== 'closed',
    )
    if (blockers.length > 0) {
      throw new Error('存在未关闭的高风险问题，不能锁定基线')
    }
    const latestBatch = data.value.validationBatches[0]

    return transact(() => {
      const baseline = data.value.baselines.find((item) => item.id === id)
      if (!baseline) return
      baseline.status = 'locked'
      baseline.lockedAt = now()
      baseline.validationBatchId = latestBatch?.id
      baseline.confirmedIssues = data.value.issues
        .filter((issue) => !issue.stale && issue.status === 'closed')
        .map((issue) => clone(issue))
      data.value.activeBaselineId = baseline.id
      appendAudit({
        action: '锁定基线',
        target: baseline.version,
        operator: '当前用户',
        detail: `校验码 ${baseline.checksum}，随快照冻结 ${baseline.confirmedIssues.length} 条已确认问题结论；未确认问题未进入基线。`,
      })
    }, { message: '基线已锁定' })
  }

  async function recordExport(format: string, count: number) {
    return transact(() => {
      appendAudit({
        action: '导出定值清单',
        target: `${format} 文件`,
        operator: '当前用户',
        detail: `导出 ${count} 条保护定值。`,
      })
    }, { message: '导出记录已写入审计' })
  }

  async function dismissNotice(id: string) {
    const notice = data.value.notices.find((item) => item.id === id)
    if (notice) notice.dismissed = true
    persistNoticesLocal(data.value.notices)
    try {
      await persistNotices(data.value.notices)
    } catch {
      /* 通知独立通道失败不阻断 */
    }
  }

  async function reset() {
    const envelope = resetState()
    data.value = envelope.state
    revision.value = envelope.revision
    lastMessage.value = '已恢复演示数据'
  }

  return {
    data,
    revision,
    hydrated,
    saving,
    validating,
    lastMessage,
    devices,
    settings,
    issues,
    scenarios,
    drafts,
    notices,
    validationBatches,
    activeBaseline,
    staleIssues,
    blockingIssues,
    hydrate,
    addDevice,
    updateDevice,
    saveSetting,
    resolveDraft,
    runValidation,
    cancelValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    addScenario,
    createBaseline,
    approveBaseline,
    recordExport,
    dismissNotice,
    reset,
  }
})
