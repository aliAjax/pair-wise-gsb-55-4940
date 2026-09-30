<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { Warning, RefreshLeft, CircleCheck } from '@element-plus/icons-vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const { notices, devices, settings, issues } = storeToRefs(store)
const expanded = ref<Record<string, boolean>>({})

const activeNotices = computed(() => notices.value.filter((notice) => !notice.dismissed))

function relayName(id: string) {
  return devices.value.find((device) => device.id === id)?.name ?? id
}
function settingLabel(id: string) {
  const setting = settings.value.find((item) => item.id === id)
  if (!setting) return id
  return `${relayName(setting.relayId)} ${setting.stage} 段`
}
function issueLabel(id: string) {
  return issues.value.find((item) => item.id === id)?.pairLabel ?? id
}
function toggle(id: string) {
  expanded.value[id] = !expanded.value[id]
}
async function dismiss(id: string) {
  await store.dismissNotice(id)
}
</script>

<template>
  <div v-if="activeNotices.length" class="notice-stack">
    <el-alert
      v-for="notice in activeNotices"
      :key="notice.id"
      :type="notice.kind === 'migration' ? 'warning' : 'error'"
      :closable="true"
      show-icon
      :title="notice.title"
      @close="dismiss(notice.id)"
    >
      <template #default>
        <div class="notice-detail">{{ notice.detail }}</div>
        <el-button link type="primary" size="small" @click="toggle(notice.id)">
          {{ expanded[notice.id] ? '收起受影响范围' : `查看受影响定值与问题（${notice.settingIds.length + notice.issueIds.length}）` }}
        </el-button>
        <div v-if="expanded[notice.id]" class="notice-scope" @click.stop>
          <div v-if="notice.relayIds.length" class="scope-group">
            <el-icon><Warning /></el-icon>
            <span>受影响装置：</span>
            <el-tag v-for="id in notice.relayIds" :key="id" size="small" effect="plain" class="scope-tag">
              {{ relayName(id) }}
            </el-tag>
          </div>
          <div v-if="notice.settingIds.length" class="scope-group">
            <el-icon><RefreshLeft /></el-icon>
            <span>受影响定值：</span>
            <el-tag
              v-for="id in notice.settingIds"
              :key="id"
              size="small"
              type="warning"
              effect="plain"
              class="scope-tag"
            >
              {{ settingLabel(id) }}
            </el-tag>
          </div>
          <div v-if="notice.issueIds.length" class="scope-group">
            <el-icon><CircleCheck /></el-icon>
            <span>待重算/确认问题：</span>
            <el-tag
              v-for="id in notice.issueIds"
              :key="id"
              size="small"
              type="danger"
              effect="plain"
              class="scope-tag"
            >
              {{ issueLabel(id) }}
            </el-tag>
          </div>
        </div>
      </template>
    </el-alert>
  </div>
</template>

<style scoped>
.notice-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.notice-detail {
  margin: 2px 0 6px;
  font-size: 13px;
  line-height: 1.6;
}

.notice-scope {
  margin-top: 6px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.75);
  border-radius: 6px;
}

.scope-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
  font-size: 12px;
}

.scope-tag {
  font-weight: normal;
}
</style>
