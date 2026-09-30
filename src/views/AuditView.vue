<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import {
  useExportMutation,
  useInjectConflictMutation,
  useInjectFailureMutation,
} from '@/api/queries'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const { data, devices, settings, issues, notices } = storeToRefs(store)
const exportMutation = useExportMutation()
const injectFailure = useInjectFailureMutation()
const injectConflict = useInjectConflictMutation()
const keyword = ref('')
const action = ref('')
const preview = ref('')
const conflictTarget = ref('')

const actions = computed(() => [...new Set(data.value.audit.map((item) => item.action))])
const filtered = computed(() =>
  data.value.audit.filter((item) => {
    const matchesKeyword =
      !keyword.value ||
      `${item.action}${item.target}${item.detail}`.toLowerCase().includes(keyword.value.toLowerCase())
    return matchesKeyword && (!action.value || item.action === action.value)
  }),
)

function relayName(id: string) {
  return devices.value.find((device) => device.id === id)?.name ?? id
}
function scopeText(ids: string[], kind: 'relay' | 'setting' | 'issue') {
  if (!ids.length) return '无'
  if (kind === 'relay') return ids.map(relayName).join('、')
  if (kind === 'setting') {
    return ids
      .map((id) => {
        const setting = settings.value.find((item) => item.id === id)
        return setting ? `${relayName(setting.relayId)} ${setting.stage}段` : id
      })
      .join('、')
  }
  return ids.map((id) => issues.value.find((item) => item.id === id)?.pairLabel ?? id).join('、')
}

async function exportList() {
  const content = await exportMutation.mutateAsync()
  preview.value = content
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `保护定值清单-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
  await store.recordExport('CSV', data.value.settings.length)
  ElMessage.success('定值清单已导出并写入审计')
}

/** 演练：下一次保存写入失败，验证“从原批次恢复 + 恢复通知留痕” */
async function armFailure() {
  await injectFailure.mutateAsync()
  ElMessage.warning('已注入：下一次任意保存将写入失败。请到装置编辑器保存一条定值观察自动回滚与恢复提示。')
}

/** 演练：下一次保存模拟另一终端抢先提交，验证“晚到提交保留草稿 + 冲突字段” */
async function armConflict() {
  await injectConflict.mutateAsync(conflictTarget.value || undefined)
  ElMessage.warning(
    conflictTarget.value
      ? `已注入：下一次保存定值 ${conflictTarget.value} 时，另一终端会先提交新版本`
      : '已注入：下一次保存定值时，另一终端会先提交新版本',
  )
}

async function resetData() {
  await ElMessageBox.confirm('将清除当前浏览器内的修改（含故障注入状态）并恢复演示数据。', '恢复演示数据', {
    confirmButtonText: '确认恢复',
    cancelButtonText: '取消',
    type: 'warning',
  })
  await store.reset()
  preview.value = ''
  ElMessage.success('演示数据已恢复')
}
</script>

<template>
  <div>
    <PageHeader
      title="审计与导出"
      description="追踪设备、定值、问题、场景、基线和导出操作；演练写入失败与并发冲突，查看迁移与恢复留痕。"
    >
      <template #actions>
        <el-button @click="resetData">恢复演示数据</el-button>
        <el-button type="primary" :loading="exportMutation.isPending.value" @click="exportList">
          导出定值清单
        </el-button>
      </template>
    </PageHeader>

    <section class="panel fault-panel">
      <div class="panel-title">
        <h3>并发与故障演练</h3>
        <span class="muted">用于验证乐观锁、写入失败回滚、校验中断与迁移恢复</span>
      </div>
      <div class="fault-actions">
        <div>
          <el-button type="danger" plain :loading="injectFailure.isPending.value" @click="armFailure">
            注入：下一次写入失败
          </el-button>
          <span class="muted">保存任意定值/问题/基线时失败，应自动回滚原批次并产生恢复通知</span>
        </div>
        <div>
          <el-select
            v-model="conflictTarget"
            clearable
            placeholder="选择定值（可空）"
            style="width: 260px"
          >
            <el-option
              v-for="setting in settings"
              :key="setting.id"
              :label="`${relayName(setting.relayId)} ${setting.stage}段`"
              :value="setting.id"
            />
          </el-select>
          <el-button type="warning" plain :loading="injectConflict.isPending.value" @click="armConflict">
            注入：下一次保存遇到他端先提交
          </el-button>
          <span class="muted">晚到提交不覆盖他人结果，保留草稿并逐字段列出冲突</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h3>版本迁移与写入恢复记录</h3>
        <span class="muted">独立持久化，重开应用仍可查看受影响定值与问题</span>
      </div>
      <el-table :data="notices" max-height="300">
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-tag :type="row.kind === 'migration' ? 'warning' : 'danger'" effect="plain">
              {{ row.kind === 'migration' ? '版本迁移' : '写入恢复' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="220" />
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ new Date(row.at).toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column label="受影响装置" min-width="160">
          <template #default="{ row }">{{ scopeText(row.relayIds, 'relay') }}</template>
        </el-table-column>
        <el-table-column label="受影响定值" min-width="200">
          <template #default="{ row }">{{ scopeText(row.settingIds, 'setting') }}</template>
        </el-table-column>
        <el-table-column label="待重算/确认问题" min-width="220">
          <template #default="{ row }">{{ scopeText(row.issueIds, 'issue') }}</template>
        </el-table-column>
      </el-table>
    </section>

    <div class="toolbar">
      <el-input v-model="keyword" placeholder="搜索操作、对象或说明" clearable style="width: 280px" />
      <el-select v-model="action" placeholder="操作类型" clearable style="width: 180px">
        <el-option v-for="item in actions" :key="item" :label="item" :value="item" />
      </el-select>
      <span class="grow" />
      <span class="muted">共 {{ filtered.length }} 条审计记录</span>
    </div>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title"><h3>操作审计日志</h3></div>
        <el-table :data="filtered" max-height="620">
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column prop="action" label="操作" width="130" />
          <el-table-column prop="target" label="对象" min-width="180" />
          <el-table-column prop="operator" label="操作人" width="95" />
          <el-table-column prop="detail" label="说明" min-width="300" />
        </el-table>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>导出预览</h3>
          <el-tag effect="plain">{{ data.settings.length }} 条定值</el-tag>
        </div>
        <el-input
          v-if="preview"
          v-model="preview"
          type="textarea"
          :rows="24"
          readonly
          class="mono"
        />
        <el-empty v-else description="点击右上角导出后在此预览 CSV 内容" />
        <el-alert
          title="导出内容来自当前浏览器持久化数据，不会上传到后端。"
          type="info"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.fault-panel {
  border: 1px dashed #d58a27;
}

.fault-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fault-actions > div {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
</style>
