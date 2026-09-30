import axios, {
  type AxiosAdapter,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios'
import type { AppState } from '@/types/domain'
import {
  armNextWriteFailure,
  commitState,
  exportSettingsText,
  loadState,
  resetState,
} from '@/services/storage'

type MockRequest = {
  state?: AppState
  patch?: Partial<AppState>
  /** 本次提交对应的业务动作，写入批次日志以便中断恢复后说明原因 */
  reason?: string
  action?: 'reset' | 'export' | 'fail-next'
}

function ok<T>(config: AxiosRequestConfig, data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: config as AxiosResponse<T>['config'],
  }
}

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))
  const payload = JSON.parse((config.data as string | undefined) ?? '{}') as MockRequest
  if (config.url === '/state' && config.method === 'get') {
    return ok(config, loadState())
  }
  if (config.url === '/state' && config.method === 'post') {
    // 两阶段写入：失败时原批次保留在本地，loadState 重开时自动恢复。
    const result = commitState(payload.state ?? loadState(), payload.reason ?? '保存业务数据')
    return ok(config, result.state)
  }
  if (config.url === '/state/patch' && config.method === 'post') {
    const state = { ...loadState(), ...payload.patch }
    const result = commitState(state, payload.reason ?? '局部更新')
    return ok(config, result.state)
  }
  if (config.url === '/actions/reset' && config.method === 'post') {
    return ok(config, resetState())
  }
  if (config.url === '/actions/export' && config.method === 'post') {
    return ok(config, { content: exportSettingsText(loadState()) })
  }
  if (config.url === '/actions/fail-next' && config.method === 'post') {
    armNextWriteFailure()
    return ok(config, { armed: true })
  }
  return Promise.reject(new Error(`未实现的本地接口：${config.method} ${config.url}`))
}

export const http = axios.create({
  baseURL: '/api',
  adapter: mockAdapter,
  headers: { 'Content-Type': 'application/json' },
})

export async function fetchState(): Promise<AppState> {
  const response = await http.get<AppState>('/state')
  return response.data
}

export async function persistState(state: AppState, reason?: string): Promise<AppState> {
  const response = await http.post<AppState>('/state', { state, reason })
  return response.data
}

export async function patchState(patch: Partial<AppState>, reason?: string): Promise<AppState> {
  const response = await http.post<AppState>('/state/patch', { patch, reason })
  return response.data
}

export async function resetMockState(): Promise<AppState> {
  const response = await http.post<AppState>('/actions/reset')
  return response.data
}

export async function exportSettings(): Promise<string> {
  const response = await http.post<{ content: string }>('/actions/export')
  return response.data.content
}

/** 让下一次状态写入失败，用于演示写入中断后的批次恢复 */
export async function armWriteFailure(): Promise<{ armed: boolean }> {
  const response = await http.post<{ armed: boolean }>('/actions/fail-next')
  return response.data
}
