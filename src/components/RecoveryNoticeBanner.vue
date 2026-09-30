<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const { recoveryNotices } = storeToRefs(store)

const kindMeta = {
  rollback: { title: '写入中断已恢复', type: 'warning' as const },
  migration: { title: '旧数据已迁移到版本模型', type: 'success' as const },
}

async function close(id: string) {
  await store.dismissRecoveryNotice(id)
}
</script>

<template>
  <div v-for="notice in recoveryNotices" :key="notice.id" style="margin-bottom: 12px">
    <el-alert
      :title="`${kindMeta[notice.kind].title}：${notice.reason}`"
      :type="kindMeta[notice.kind].type"
      show-icon
      :closable="true"
      @close="close(notice.id)"
    >
      <div style="padding-top: 6px; line-height: 1.7">
        <div>{{ notice.detail }}</div>
        <div style="margin-top: 4px">
          恢复时间：{{ new Date(notice.restoredAt).toLocaleString('zh-CN') }}
        </div>
        <div v-if="notice.affectedSettings.length" style="margin-top: 4px">
          <strong>受影响定值（{{ notice.affectedSettings.length }}）：</strong>
          <el-tag
            v-for="item in notice.affectedSettings"
            :key="item.settingId"
            size="small"
            effect="plain"
            style="margin: 2px 6px 2px 0"
          >
            {{ item.label }}
          </el-tag>
        </div>
        <div v-if="notice.affectedIssues.length" style="margin-top: 4px">
          <strong>受影响校验问题（{{ notice.affectedIssues.length }}）：</strong>
          <el-tag
            v-for="item in notice.affectedIssues"
            :key="item.issueId"
            size="small"
            type="danger"
            effect="plain"
            style="margin: 2px 6px 2px 0"
          >
            {{ item.pairLabel }}
          </el-tag>
        </div>
      </div>
    </el-alert>
  </div>
</template>
