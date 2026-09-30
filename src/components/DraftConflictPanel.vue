<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/stores/app'
import { settingFieldLabels } from '@/services/labels'

const store = useAppStore()
const { drafts, devices } = storeToRefs(store)

const pending = computed(() => drafts.value.filter((draft) => draft.status === 'pending'))

function relayName(relayId: string) {
  return devices.value.find((device) => device.id === relayId)?.name ?? relayId
}

async function merge(draftId: string) {
  await store.mergeDraft(draftId)
  ElMessage.success('已采纳草稿并保存为新版本')
}

async function discard(draftId: string) {
  await store.discardDraft(draftId)
  ElMessage.success('草稿已放弃')
}

function formatValue(value: string | number | boolean) {
  if (typeof value === 'boolean') return value ? '投入' : '退出'
  return String(value)
}
</script>

<template>
  <section v-if="pending.length" class="panel draft-panel">
    <div class="panel-title">
      <h3>晚到提交草稿（{{ pending.length }}）</h3>
      <el-tag type="danger" effect="plain">存在并发冲突，未覆盖先保存内容</el-tag>
    </div>
    <el-alert
      title="以下编辑基于已过期的设备版本，系统已保留草稿并列出冲突字段；请比对后选择采纳或放弃。"
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
    />
    <div v-for="draft in pending" :key="draft.id" class="draft-card">
      <div class="draft-head">
        <strong>{{ relayName(draft.relayId) }} · {{ draft.payload.stage }} 段</strong>
        <span class="muted">
          编辑基于 V{{ draft.baseVersion }} → 服务器已到 V{{ draft.serverVersion }}
        </span>
      </div>
      <el-table :data="draft.conflicts" size="small" border style="margin: 8px 0">
        <el-table-column label="冲突字段" width="130">
          <template #default="{ row }">
            {{ settingFieldLabels[row.field as keyof typeof settingFieldLabels] ?? row.field }}
          </template>
        </el-table-column>
        <el-table-column label="先保存值（服务器）" width="170">
          <template #default="{ row }">
            <span class="diff-before">{{ formatValue(row.serverValue) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="我的草稿值" min-width="150">
          <template #default="{ row }">
            <span class="diff-after">{{ formatValue(row.draftValue) }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!draft.conflicts.length" class="muted" style="margin: 6px 0">
        双方修改的字段不重叠，可直接采纳草稿合并为新版本。
      </div>
      <div class="draft-actions">
        <el-button size="small" type="primary" @click="merge(draft.id)">采纳草稿（升版本保存）</el-button>
        <el-button size="small" @click="discard(draft.id)">放弃草稿</el-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.draft-panel {
  border-color: #e6b877;
}

.draft-card {
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fdf8f1;
  border: 1px solid #ecd9bd;
  border-radius: 6px;
}

.draft-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.draft-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
</style>
