<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/stores/app'
import { fieldLabel } from '@/services/concurrency'
import type { ProtectionSetting, SettingDraft } from '@/types/domain'

const props = defineProps<{ draft: SettingDraft | null }>()
const emit = defineEmits<{
  closed: []
  reopen: [setting: ProtectionSetting, baseVersion: number, base: ProtectionSetting | null]
}>()

const store = useAppStore()

const serverSetting = computed<ProtectionSetting | null>(() => {
  if (!props.draft) return null
  return store.settings.find((item) => item.id === props.draft!.settingId) ?? null
})
const relay = computed(() =>
  props.draft ? store.devices.find((device) => device.id === props.draft!.relayId) : undefined,
)

/** 合并编辑值：默认取草稿值，用户可逐字段改用服务器现值 */
const merged = reactive<Record<string, string | number | boolean>>({})

watch(
  () => props.draft?.id,
  () => {
    Object.keys(merged).forEach((key) => delete merged[key])
    if (props.draft) {
      props.draft.conflictFields.forEach((conflict) => {
        merged[conflict.field] = conflict.draft as string | number | boolean
      })
    }
  },
  { immediate: true },
)

function displayValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '（新定值，无现值）'
  if (typeof value === 'boolean') return value ? '投入/是' : '退出/否'
  return String(value)
}

async function adoptServer() {
  if (!props.draft) return
  await store.resolveDraft(props.draft.id, 'discard')
  ElMessage.success('已采用其他终端保存的服务器现值，草稿作废')
  emit('closed')
}

function reopenWithMerged() {
  if (!props.draft) return
  const base = serverSetting.value ?? props.draft.baseSetting
  const next: ProtectionSetting = {
    ...props.draft.setting,
    ...Object.fromEntries(
      props.draft.conflictFields.map((conflict) => [
        conflict.field,
        merged[conflict.field],
      ]),
    ),
  } as ProtectionSetting
  emit('reopen', next, props.draft.expectedRelayVersion, base)
  ElMessage.info('已把合并后的草稿载入编辑框，请确认后再次保存')
  emit('closed')
}
</script>

<template>
  <el-dialog
    :model-value="draft !== null"
    title="保存冲突：装置版本已被其他终端更新"
    width="680px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => !v && emit('closed')"
  >
    <el-alert
      v-if="draft"
      type="error"
      :closable="false"
      show-icon
      :title="`保存前冻结的是 V${draft.baseSetting ? draft.expectedRelayVersion - 1 : draft.expectedRelayVersion}，当前服务器版本为 V${relay?.version ?? draft.expectedRelayVersion}。你的晚到提交未覆盖他人结果，已保留为草稿。`"
    />
    <el-table v-if="draft" :data="draft.conflictFields" style="margin-top: 12px">
      <el-table-column label="冲突字段" width="130">
        <template #default="{ row }">{{ fieldLabel(row.field as keyof ProtectionSetting) }}</template>
      </el-table-column>
      <el-table-column label="你打开时的值" width="150">
        <template #default="{ row }">
          <span class="cell-base">{{ displayValue(row.base) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="服务器现值（他人已保存）" width="180">
        <template #default="{ row }">
          <span class="cell-server">{{ displayValue(row.server) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="你的草稿值" min-width="180">
        <template #default="{ row }">
          <el-radio-group v-model="merged[row.field]" size="small">
            <el-radio :value="row.draft">{{ displayValue(row.draft) }}（草稿）</el-radio>
            <el-radio :value="row.server">{{ displayValue(row.server) }}（服务器）</el-radio>
          </el-radio-group>
        </template>
      </el-table-column>
    </el-table>
    <p class="conflict-note" v-if="draft && !draft.conflictFields.length">
      服务器版本虽已变化，但没有与草稿实质冲突的字段，可直接重新载入草稿再次保存。
    </p>
    <template #footer>
      <el-button @click="adoptServer">采用服务器值，放弃草稿</el-button>
      <el-button type="primary" @click="reopenWithMerged">按所选合并并重新编辑</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.cell-base {
  color: #909399;
  text-decoration: line-through;
}
.cell-server {
  color: #c84c4c;
  font-weight: 600;
}
.conflict-note {
  margin-top: 10px;
  color: #708292;
  font-size: 13px;
}
</style>
