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
const { data, devices, settings, issues } = storeToRefs(store)
const typeFilter = ref<ValidationIssue['type'] | ''>('')
const levelFilter = ref<ValidationIssue['level'] | ''>('')
const statusFilter = ref<ValidationIssue['status'] | ''>('')
const validityFilter = ref<'' | 'current' | 'stale'>('')
const selected = ref<ValidationIssue>()
const reply = ref('')
const validating = ref(false)
const deviceFilter = ref(typeof route.query.device === 'string' ? route.query.device : '')

const filtered = computed(() =>
  issues.value.filter((issue) => {
    const matchesDevice = !deviceFilter.value || issue.deviceIds.includes(deviceFilter.value)
    const matchesType = !typeFilter.value || issue.type === typeFilter.value
    const matchesLevel = !levelFilter.value || issue.level === levelFilter.value
    const matchesStatus = !statusFilter.value || issue.status === statusFilter.value
    const matchesValidity = !validityFilter.value || issue.validity === validityFilter.value
    return matchesDevice && matchesType && matchesLevel && matchesStatus && matchesValidity
  }),
)

const staleCount = computed(() => issues.value.filter((issue) => issue.validity === 'stale').length)

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
  validating.value = true
  try {
    const result = await store.runValidation()
    selected.value = result[0]
    ElMessage.success(`批量校验完成，共发现 ${result.length} 条问题`)
  } finally {
    validating.value = false
  }
}

async function markReplying() {
  if (!selected.value) return
  if (selected.value.validity === 'stale') {
    ElMessage.warning('该问题依据的定值版本已变化，请先重新批量校验')
    return
  }
  await store.updateIssue({ ...selected.value, status: 'replying' })
  ElMessage.success('问题已进入意见回复状态')
}

async function closeIssue() {
  if (!selected.value) return
  if (selected.value.validity === 'stale') {
    ElMessage.warning('失效结论不能关闭确认，请先重新批量校验')
    return
  }
  await store.updateIssue({ ...selected.value, status: 'closed' })
  ElMessage.success('问题已关闭，关闭动作已记录审计')
}

async function submitReply() {
  if (!selected.value || !reply.value.trim()) return
  if (selected.value.validity === 'stale') {
    ElMessage.warning('该问题已失效，请重新校验后再回复')
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
      description="按保护对检查越级跳闸、时限倒挂、灵敏度不足和重合逻辑冲突，并给出可追溯处理意见。"
    >
      <template #actions>
        <el-button @click="deviceFilter = ''">清除设备定位</el-button>
        <el-button type="primary" :loading="validating" @click="runValidation">
          批量校验（按当前版本重算）
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="staleCount"
      :title="`有 ${staleCount} 条校验问题因定值版本变化已失效，旧结论保留但不允许确认；请重新批量校验。`"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 12px"
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
      <el-select v-model="validityFilter" placeholder="结论有效性" style="width: 140px">
        <el-option label="当前有效" value="current" />
        <el-option label="已失效待重算" value="stale" />
      </el-select>
      <span class="grow" />
      <span class="muted">当前显示 {{ filtered.length }} / {{ issues.length }} 条</span>
    </div>

    <div class="three-column">
      <section class="panel">
        <div class="panel-title"><h3>异常保护对</h3></div>
        <div v-if="filtered.length" class="issue-list">
          <button
            v-for="issue in filtered"
            :key="issue.id"
            class="issue-list-item"
            :class="{ active: selected?.id === issue.id }"
            type="button"
            @click="selected = issue"
          >
            <span
              class="issue-dot"
              :class="issue.level"
            />
            <span>
              <strong>{{ issue.pairLabel }}</strong>
              <el-tag
                v-if="issue.validity === 'stale'"
                size="small"
                type="info"
                effect="plain"
                style="margin-left: 6px"
              >
                已失效
              </el-tag>
              <small>{{ issue.message }}</small>
            </span>
          </button>
        </div>
        <el-empty v-else description="当前筛选无问题" />
      </section>

      <section class="panel">
        <template v-if="selected">
          <div class="panel-title">
            <div>
              <h3>{{ selected.pairLabel }}</h3>
              <span class="muted">{{ selected.message }}</span>
            </div>
            <div style="display: flex; gap: 6px; align-items: center">
              <el-tag :type="selected.validity === 'stale' ? 'info' : 'success'" effect="plain">
                {{ selected.validity === 'stale' ? '结论已失效' : '当前版本有效' }}
              </el-tag>
              <el-tag :type="selected.status === 'closed' ? 'success' : 'warning'" effect="plain">
                {{ selected.status === 'closed' ? '已关闭' : selected.status === 'replying' ? '回复中' : '待处理' }}
              </el-tag>
            </div>
          </div>
          <el-alert
            v-if="selected.validity === 'stale'"
            :title="`该结论基于旧定值版本，已于 ${selected.staleAt ? new Date(selected.staleAt).toLocaleString('zh-CN') : ''} 失效；重新批量校验前不能回复或关闭，也不会随旧结论锁进基线。`"
            type="info"
            :closable="false"
            show-icon
            style="margin-bottom: 10px"
          />
          <el-alert
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
            <el-button
              :disabled="selected.status === 'closed' || selected.validity === 'stale'"
              @click="markReplying"
            >
              进入意见回复
            </el-button>
            <el-button
              type="success"
              :disabled="selected.status === 'closed' || selected.validity === 'stale'"
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
            placeholder="填写短路计算依据、整定说明或处理意见"
          />
          <el-button
            type="primary"
            style="width: 100%; margin-top: 10px"
            :disabled="!reply.trim()"
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
        <span class="muted">箭头方向表示上级保护到下级受控设备</span>
      </div>
      <DependencyGraph :devices="devices" />
    </section>
  </div>
</template>

<style scoped>
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
