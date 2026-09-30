<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { diffSettings } from '@/services/validation'
import { settingFieldLabels } from '@/services/labels'

const store = useAppStore()
const { data, settings } = storeToRefs(store)
const selectedId = ref(data.value.activeBaselineId ?? data.value.baselines[0]?.id ?? '')
const createDialog = ref(false)
const baselineNote = ref('')
const comment = ref('')

const selected = computed(() => data.value.baselines.find((item) => item.id === selectedId.value))
const diffs = computed(() => {
  if (!selected.value) return []
  return diffSettings(settings.value, selected.value.snapshot)
})
const baselineComments = computed(() =>
  data.value.comments.filter(
    (item) => item.targetType === 'baseline' && item.targetId === selectedId.value,
  ),
)

/** 快照之后定值版本又发生变化（含新增/删除），旧快照不能再锁定 */
const versionDrifted = computed(() => {
  if (!selected.value) return false
  return settings.value.some((setting) => {
    const snapVersion = selected.value?.settingVersions[setting.id]
    return snapVersion === undefined || snapVersion !== setting.version
  })
})

const staleIssues = computed(() => data.value.issues.filter((issue) => issue.validity === 'stale'))
const openHighIssues = computed(() =>
  data.value.issues.filter((issue) => issue.level === 'high' && issue.status !== 'closed'),
)
const openIssues = computed(() => data.value.issues.filter((issue) => issue.status !== 'closed'))
const canLock = computed(
  () =>
    selected.value &&
    selected.value.status !== 'locked' &&
    !versionDrifted.value &&
    staleIssues.value.length === 0 &&
    openIssues.value.length === 0,
)

watch(
  () => data.value.baselines,
  (list) => {
    if (!list.some((item) => item.id === selectedId.value)) selectedId.value = list[0]?.id ?? ''
  },
)

const fieldLabels = settingFieldLabels

async function createBaseline() {
  if (!baselineNote.value.trim()) {
    ElMessage.warning('请填写本次基线说明')
    return
  }
  const created = await store.createBaseline(baselineNote.value.trim())
  selectedId.value = created.id
  baselineNote.value = ''
  createDialog.value = false
  ElMessage.success('基线已提交会签')
}

async function lockBaseline() {
  if (!selected.value) return
  try {
    await store.approveBaseline(selected.value.id)
    ElMessage.success('基线已批准并锁定')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '基线锁定失败')
  }
}

async function submitComment() {
  if (!selected.value || !comment.value.trim()) return
  await store.addComment({
    targetType: 'baseline',
    targetId: selected.value.id,
    author: '当前用户',
    content: comment.value.trim(),
    status: 'open',
  })
  comment.value = ''
  ElMessage.success('会签意见已记录')
}
</script>

<template>
  <div>
    <PageHeader
      title="会签与基线"
      description="按定值版本冻结快照；版本漂移、失效结论或未确认问题存在时不允许锁定基线。"
    >
      <template #actions>
        <el-button @click="createDialog = true">创建基线上会签</el-button>
        <el-button
          type="primary"
          :disabled="!canLock"
          :loading="store.saving"
          @click="lockBaseline"
        >
          批准并锁定
        </el-button>
      </template>
    </PageHeader>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>版本清单</h3>
          <span class="muted">锁定后作为后续差异比较基线</span>
        </div>
        <el-table :data="data.baselines" highlight-current-row @current-change="selectedId = $event?.id ?? selectedId">
          <el-table-column prop="version" label="版本" width="90" />
          <el-table-column prop="note" label="说明" min-width="220" />
          <el-table-column prop="createdBy" label="创建人" width="95" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag
                :type="row.status === 'locked' ? 'success' : row.status === 'reviewing' ? 'warning' : 'info'"
                effect="plain"
              >
                {{ row.status === 'locked' ? '已锁定' : row.status === 'reviewing' ? '会签中' : '草稿' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="checksum" label="校验码" width="115" />
        </el-table>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>{{ selected?.version ?? '未选择版本' }}</h3>
          <el-tag v-if="selected" :type="selected.status === 'locked' ? 'success' : 'warning'" effect="plain">
            {{ selected.status === 'locked' ? '基线已冻结' : '会签进行中' }}
          </el-tag>
        </div>
        <template v-if="selected">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="基线说明">{{ selected.note }}</el-descriptions-item>
            <el-descriptions-item label="创建时间">
              {{ new Date(selected.createdAt).toLocaleString('zh-CN') }}
            </el-descriptions-item>
            <el-descriptions-item label="锁定时间">
              {{ selected.lockedAt ? new Date(selected.lockedAt).toLocaleString('zh-CN') : '尚未锁定' }}
            </el-descriptions-item>
            <el-descriptions-item label="快照定值">{{ selected.snapshot.length }} 条</el-descriptions-item>
            <el-descriptions-item label="版本一致性">
              <el-tag :type="versionDrifted ? 'danger' : 'success'" effect="plain">
                {{ versionDrifted ? '快照后定值版本已变化' : '与当前定值版本一致' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="已确认问题">
              {{ selected.confirmedIssues?.length ?? 0 }} 条（仅锁定时已关闭且有效的结论会被冻结）
            </el-descriptions-item>
            <el-descriptions-item label="校验码">
              <span class="mono">{{ selected.checksum }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-alert
            v-if="versionDrifted && selected.status !== 'locked'"
            title="定值版本相对快照已变化，此基线不能锁定；请按当前定值重新创建基线。"
            type="error"
            show-icon
            :closable="false"
            style="margin: 12px 0"
          />

          <div class="panel-title" style="margin-top: 18px">
            <h3>与当前定值差异</h3>
            <el-tag :type="diffs.length ? 'warning' : 'success'" effect="plain">
              {{ diffs.length }} 项变化
            </el-tag>
          </div>
          <el-table :data="diffs" max-height="260">
            <el-table-column label="保护装置" width="115">
              <template #default="{ row }">
                {{ data.devices.find((device) => device.id === row.relayName)?.name ?? row.relayName }}
              </template>
            </el-table-column>
            <el-table-column label="字段" width="110">
              <template #default="{ row }">{{ fieldLabels[row.field as keyof typeof fieldLabels] ?? row.field }}</template>
            </el-table-column>
            <el-table-column label="基线值" width="120">
              <template #default="{ row }"><span class="diff-before">{{ row.before }}</span></template>
            </el-table-column>
            <el-table-column label="当前值" min-width="130">
              <template #default="{ row }"><span class="diff-after">{{ row.after }}</span></template>
            </el-table-column>
          </el-table>
        </template>
      </section>
    </div>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title"><h3>会签意见</h3></div>
        <div v-for="item in baselineComments" :key="item.id" class="comment-item">
          <div class="comment-meta">
            <strong>{{ item.author }}</strong>
            <span>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</span>
          </div>
          <div>{{ item.content }}</div>
        </div>
        <el-empty v-if="!baselineComments.length" description="该版本暂无会签意见" :image-size="70" />
        <el-input
          v-model="comment"
          type="textarea"
          :rows="3"
          placeholder="填写对定值基线、差异或锁定条件的意见"
        />
        <el-button type="primary" style="margin-top: 10px" :disabled="!comment.trim()" @click="submitComment">
          记录意见
        </el-button>
      </section>

      <section class="panel">
        <div class="panel-title"><h3>锁定条件</h3></div>
        <div class="lock-checklist">
          <el-checkbox :model-value="true" disabled>批量校验已执行并留痕</el-checkbox>
          <el-checkbox :model-value="true" disabled>至少一个故障场景已完成验证</el-checkbox>
          <el-checkbox :model-value="!versionDrifted" disabled>
            快照版本与当前定值一致（无版本漂移）
          </el-checkbox>
          <el-checkbox :model-value="staleIssues.length === 0" disabled>
            无因版本变化而失效、尚未重算确认的问题
          </el-checkbox>
          <el-checkbox :model-value="openHighIssues.length === 0" disabled>
            高风险问题全部关闭
          </el-checkbox>
          <el-checkbox :model-value="openIssues.length === 0" disabled>
            全部校验问题已确认关闭
          </el-checkbox>
        </div>
        <el-alert
          v-if="versionDrifted"
          title="定值版本相对快照已变化，需重新创建基线，旧结论不能锁定。"
          type="error"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="staleIssues.length"
          :title="`有 ${staleIssues.length} 条问题结论已失效，请重新批量校验后再锁定，失效结论不会进入基线。`"
          type="error"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="openHighIssues.length"
          title="当前存在未关闭的高风险问题，批准锁定会被系统拒绝。"
          type="error"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="openIssues.length"
          :title="`仍有 ${openIssues.length} 条未确认问题，不能随旧结论锁进基线。`"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else
          title="锁定条件已满足，可以执行批准并锁定。"
          type="success"
          :closable="false"
          show-icon
        />

        <div v-if="selected?.confirmedIssues?.length" class="panel-title" style="margin-top: 16px">
          <h3>随基线冻结的已确认问题</h3>
        </div>
        <el-table
          v-if="selected?.confirmedIssues?.length"
          :data="selected.confirmedIssues"
          size="small"
          max-height="220"
        >
          <el-table-column prop="pairLabel" label="保护对" min-width="160" />
          <el-table-column prop="message" label="关闭时结论" min-width="220" show-overflow-tooltip />
          <el-table-column label="依据版本" width="150">
            <template #default="{ row }">
              <span class="mono">
                {{ Object.entries(row.basis).map(([id, v]) => `${id.slice(-6)}@V${v}`).join('，') }}
              </span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <el-dialog v-model="createDialog" title="创建基线上会签" width="520px">
      <el-form label-width="90px">
        <el-form-item label="基线说明" required>
          <el-input v-model="baselineNote" type="textarea" :rows="4" placeholder="说明变更范围、计算依据和会签要求" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!baselineNote.trim()" @click="createBaseline">
          提交会签
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
