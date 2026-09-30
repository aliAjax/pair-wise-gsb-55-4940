<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import GuardCurveCanvas from '@/components/GuardCurveCanvas.vue'
import DependencyGraph from '@/components/DependencyGraph.vue'
import { useAppStore } from '@/stores/app'
import type { ValidationIssue } from '@/types/domain'

const route = useRoute()
const store = useAppStore()
const { data, devices, settings, issues, validationBatches, staleIssues, validating } =
  storeToRefs(store)
const typeFilter = ref<ValidationIssue['type'] | ''>('')
const levelFilter = ref<ValidationIssue['level'] | ''>('')
const statusFilter = ref<ValidationIssue['status'] | ''>('')
const staleOnly = ref(false)
const selected = ref<ValidationIssue>()
const reply = ref('')
const deviceFilter = ref(typeof route.query.device === 'string' ? route.query.device : '')

const filtered = computed(() =>
  issues.value.filter((issue) => {
    const matchesDevice = !deviceFilter.value || issue.deviceIds.includes(deviceFilter.value)
    const matchesType = !typeFilter.value || issue.type === typeFilter.value
    const matchesLevel = !levelFilter.value || issue.level === levelFilter.value
    const matchesStatus = !statusFilter.value || issue.status === statusFilter.value
    const matchesStale = !staleOnly.value || issue.stale
    return matchesDevice && matchesType && matchesLevel && matchesStatus && matchesStale
  }),
)

const latestBatch = computed(() => validationBatches.value[0])
const relayVersionText = (issue: ValidationIssue) =>
  Object.entries(issue.baseVersions ?? {})
    .map(([id, version]) => `${devices.value.find((d) => d.id === id)?.name ?? id}@V${version}`)
    .join('，')

const selectedSetting = computed(() =>
  settings.value.find((setting) => setting.id === selected.value?.settingIds[0]),
)

const selectedComments = computed(() =>
  data.value.comments.filter(
    (comment) => comment.targetType === 'issue' && comment.targetId === selected.value?.id,
  ),
)

watch(
  filtered,
  (list) => {
    if (!selected.value || !list.some((issue) => issue.id === selected.value?.id)) {
      selected.value = list[0]
    }
  },
  { immediate: true },
)

async function runValidation() {
  try {
    const result = await store.runValidation()
    selected.value = result[0]
    ElMessage.success(`批量校验批次完整完成，共 ${result.length} 条结论基于当前装置版本`)
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '批量校验未完成，本轮半成品结果已丢弃')
  }
}

function cancelValidation() {
  store.cancelValidation()
  ElMessage.warning('已中断校验：本轮结果未落库，问题列表保持上一完整批次')
}

async function markReplying() {
  if (!selected.value) return
  if (selected.value.stale) {
    ElMessage.warning('结论已失效，请重新批量校验后再处理')
    return
  }
  await store.updateIssue({ ...selected.value, status: 'replying' })
  ElMessage.success('问题已进入意见回复状态')
}

async function closeIssue() {
  if (!selected.value) return
  if (selected.value.stale) {
    ElMessage.warning('该结论已因装置版本变化失效，请先重新批量校验确认后再关闭')
    return
  }
  await store.updateIssue({ ...selected.value, status: 'closed' })
  ElMessage.success('问题已关闭，关闭动作已记录审计')
}

async function submitReply() {
  if (!selected.value || !reply.value.trim()) return
  if (selected.value.stale) {
    ElMessage.warning('结论已失效，请重新批量校验后再提交意见')
    return
  }
  await store.addComment({
    targetType: 'issue',
    targetId: selected.value.id,
    author: '当前用户',
    content: reply.value.trim(),
    status: 'resolved',
  })
  await store.updateIssue({ ...selected.value, status: 'replying' })
  reply.value = ''
  ElMessage.success('校验依据与回复已提交')
}
</script>

<template>
  <div>
    <PageHeader
      title="保护配合校核"
      description="按保护对检查越级跳闸、时限倒挂、灵敏度不足和重合逻辑冲突；装置版本变化后旧结论自动失效，需重算确认。"
    >
      <template #actions>
        <el-button @click="deviceFilter = ''; staleOnly = false">清除定位</el-button>
        <el-button v-if="validating" type="danger" plain @click="cancelValidation">
          中断本轮校验
        </el-button>
        <el-button type="primary" :loading="validating" @click="runValidation">
          {{ validating ? '正在批量校验…' : '批量校验' }}
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="staleIssues.length"
      type="warning"
      show-icon
      :closable="false"
      class="stale-banner"
      :title="`有 ${staleIssues.length} 条校验结论因装置版本变化而失效，必须重新批量校验；失效结论不允许关闭、不会锁进基线。`"
    />

    <div class="toolbar">
      <el-select v-model="deviceFilter" clearable placeholder="定位设备" style="width: 220px">
        <el-option
          v-for="device in devices.filter((item) => ['line', 'transformer', 'bus'].includes(item.kind))"
          :key="device.id"
          :label="device.name"
          :value="device.id"
        />
      </el-select>
      <el-select v-model="typeFilter" clearable placeholder="问题类型" style="width: 150px">
        <el-option label="越级跳闸" value="overreach" />
        <el-option label="时限倒挂" value="time-inversion" />
        <el-option label="灵敏度不足" value="sensitivity" />
        <el-option label="重合逻辑" value="reclose" />
      </el-select>
      <el-select v-model="levelFilter" clearable placeholder="风险等级" style="width: 130px">
        <el-option label="高" value="high" />
        <el-option label="中" value="medium" />
        <el-option label="低" value="low" />
      </el-select>
      <el-select v-model="statusFilter" clearable placeholder="处理状态" style="width: 150px">
        <el-option label="待处理" value="open" />
        <el-option label="回复中" value="replying" />
        <el-option label="已关闭" value="closed" />
      </el-select>
      <el-checkbox v-model="staleOnly" border>仅看失效待重算</el-checkbox>
      <span class="grow" />
      <span class="muted">
        {{ filtered.length }} / {{ issues.length }} 条 · 最近批次
        {{ latestBatch ? latestBatch.id.slice(-6) : '无' }}
      </span>
    </div>

    <div class="three-column">
      <section class="panel">
        <div class="panel-title"><h3>异常保护对</h3></div>
        <div v-if="filtered.length" class="issue-list">
          <button
            v-for="issue in filtered"
            :key="issue.id"
            class="issue-list-item"
            :class="{ active: selected?.id === issue.id, stale: issue.stale }"
            type="button"
            @click="selected = issue"
          >
            <span class="issue-dot" :class="issue.level" />
            <span>
              <strong>
                {{ issue.pairLabel }}
                <el-tag v-if="issue.stale" size="small" type="danger" effect="dark">失效待重算</el-tag>
              </strong>
              <small>{{ issue.message }}</small>
              <small class="version-line">结论基线：{{ relayVersionText(issue) }}</small>
            </span>
          </button>
        </div>
        <el-empty v-else description="当前筛选无问题" />
      </section>

      <section class="panel">
        <template v-if="selected">
          <div class="panel-title">
            <div>
              <h3>
                {{ selected.pairLabel }}
                <el-tag v-if="selected.stale" type="danger" effect="dark" size="small">
                  装置版本已变化 · 结论失效
                </el-tag>
              </h3>
              <span class="muted">{{ selected.message }}</span>
            </div>
            <el-tag
              :type="selected.status === 'closed' ? 'success' : selected.status === 'replying' ? 'warning' : 'info'"
              effect="plain"
            >
              {{ selected.status === 'closed' ? '已关闭' : selected.status === 'replying' ? '回复中' : '待处理' }}
            </el-tag>
          </div>

          <el-descriptions :column="1" border size="small" class="version-box">
            <el-descriptions-item label="结论依据版本">{{ relayVersionText(selected) }}</el-descriptions-item>
            <el-descriptions-item label="校验批次">{{ selected.batchId ?? '旧数据（无批次）' }}</el-descriptions-item>
          </el-descriptions>

          <el-alert
            v-if="selected.stale"
            title="关联保护装置在该结论形成后已保存新版本，旧结论作废。请执行批量校验重算，确认后再关闭或锁定基线。"
            type="error"
            :closable="false"
            show-icon
            style="margin-top: 10px"
          />
          <el-alert
            v-else
            :title="selected.suggestion"
            :type="selected.level === 'high' ? 'error' : 'warning'"
            :closable="false"
            show-icon
          />
          <div class="panel-title" style="margin-top: 18px">
            <h3>动作特性定位</h3>
          </div>
          <GuardCurveCanvas
            :settings="settings"
            :selected-relay-id="selectedSetting?.relayId"
          />
          <div class="timeline-actions" style="margin-top: 14px">
            <el-button :disabled="selected.status === 'closed' || selected.stale" @click="markReplying">
              进入意见回复
            </el-button>
            <el-button
              type="success"
              :disabled="selected.status === 'closed' || selected.stale"
              @click="closeIssue"
            >
              关闭问题
            </el-button>
          </div>
        </template>
        <el-empty v-else description="请选择需要审校的问题" />
      </section>

      <section class="panel">
        <div class="panel-title"><h3>意见与会签记录</h3></div>
        <template v-if="selected">
          <div v-for="comment in selectedComments" :key="comment.id" class="comment-item">
            <div class="comment-meta">
              <strong>{{ comment.author }}</strong>
              <span>{{ new Date(comment.createdAt).toLocaleString('zh-CN') }}</span>
            </div>
            <div>{{ comment.content }}</div>
          </div>
          <el-empty v-if="!selectedComments.length" description="暂无意见" :image-size="70" />
          <el-input
            v-model="reply"
            type="textarea"
            :rows="4"
            :disabled="selected.stale"
            placeholder="填写短路计算依据、整定说明或处理意见（失效结论需先重算）"
          />
          <el-button
            type="primary"
            style="width: 100%; margin-top: 10px"
            :disabled="!reply.trim() || selected.stale"
            @click="submitReply"
          >
            提交回复
          </el-button>
        </template>
      </section>
    </div>

    <section class="panel">
      <div class="panel-title">
        <h3>装置依赖图</h3>
        <span class="muted">箭头方向表示上级保护到下级受控设备；旁注为装置冻结版本</span>
      </div>
      <DependencyGraph :devices="devices" />
    </section>
  </div>
</template>

<style scoped>
.stale-banner {
  margin-bottom: 12px;
}

.version-box {
  margin-top: 10px;
}

.version-line {
  color: #b4782a;
}

.issue-list {
  max-height: 570px;
  overflow: auto;
}

.issue-list-item {
  display: flex;
  gap: 10px;
  width: 100%;
  padding: 11px 10px;
  margin-bottom: 7px;
  color: #263847;
  text-align: left;
  background: #f7f9fa;
  border: 1px solid #e0e7ec;
  border-radius: 5px;
  cursor: pointer;
}

.issue-list-item:hover,
.issue-list-item.active {
  background: #e9f4f3;
  border-color: #63a7a2;
}

.issue-list-item.stale {
  background: #fdf3ec;
  border-color: #e0b088;
}

.issue-list-item strong,
.issue-list-item small {
  display: block;
}

.issue-list-item small {
  display: -webkit-box;
  margin-top: 5px;
  overflow: hidden;
  color: #708292;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.issue-dot {
  flex: 0 0 8px;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  background: #5d8fae;
  border-radius: 50%;
}

.issue-dot.high {
  background: #c84c4c;
}

.issue-dot.medium {
  background: #d58a27;
}
</style>
