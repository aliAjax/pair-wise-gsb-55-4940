import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed } from 'vue'
import {
  exportSettings,
  fetchState,
  injectConflict,
  injectWriteFailure,
  persistState,
  resetMockState,
} from './client'
import type { StateEnvelope } from '@/services/storage'
import type { AppState } from '@/types/domain'

export const appStateQueryKey = ['grid-protection-state'] as const

export function useAppStateQuery() {
  return useQuery({
    queryKey: appStateQueryKey,
    queryFn: fetchState,
    staleTime: 30_000,
  })
}

export function usePersistStateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ state, revision }: { state: AppState; revision: number }) =>
      persistState(state, revision),
    onSuccess: (envelope: StateEnvelope) =>
      queryClient.setQueryData(appStateQueryKey, envelope),
  })
}

export function useResetStateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: resetMockState,
    onSuccess: (envelope) => queryClient.setQueryData(appStateQueryKey, envelope),
  })
}

export function useExportMutation() {
  return useMutation({
    mutationFn: exportSettings,
  })
}

/** 演示：下一次写入失败 */
export function useInjectFailureMutation() {
  return useMutation({
    mutationFn: () => injectWriteFailure(),
  })
}

/** 演示：下一次保存时其他终端已抢先提交 */
export function useInjectConflictMutation() {
  return useMutation({
    mutationFn: (settingId?: string) => injectConflict(settingId),
  })
}

export function useIssueStats() {
  const query = useAppStateQuery()
  return computed(() => {
    const issues = query.data.value?.state.issues ?? []
    return {
      total: issues.length,
      high: issues.filter((issue) => issue.level === 'high').length,
      open: issues.filter((issue) => issue.status !== 'closed').length,
      stale: issues.filter((issue) => issue.stale).length,
    }
  })
}
