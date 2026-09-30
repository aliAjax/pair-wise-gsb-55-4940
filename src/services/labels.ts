import type { SettingEditableField } from '@/types/domain'

/** 定值业务字段的中文标签，冲突列表、差异比较、草稿处理共用 */
export const settingFieldLabels: Record<SettingEditableField, string> = {
  protectedDeviceId: '保护对象',
  stage: '段位',
  currentA: '电流定值',
  timeS: '动作时限',
  direction: '方向',
  sensitivity: '灵敏度',
  recloseEnabled: '重合闸投入',
  recloseDelayS: '重合延迟',
  startCondition: '启动条件',
}
