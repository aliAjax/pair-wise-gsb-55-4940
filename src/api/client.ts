import axios, {
  type AxiosAdapter,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios'
import type { AppState } from '@/types/domain'
import {
  armConflict,
  armWriteFailure,
  exportSettingsText,
  loadNotices,
  loadState,
  resetState,
  saveNotices,
  saveState,
  type StateEnvelope,
} from '@/services/storage'

interface PersistRequest {
  state?: AppState
  expectedRevision?: number
}

/** 服务端版本已被其他终端推进时抛出，携带服务端现值 */
export class RevisionConflictError extends Error {
  serverEnvelope: StateEnvelope
  constructor(serverEnvelope: StateEnvelope) {
    super('设备版本已被其他终端更新')
    this.name = 'RevisionConflictError'
    this.serverEnvelope = serverEnvelope
  }
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

function fail(config: AxiosRequestConfig, status: number, message: string): AxiosResponse {
  return {
    data: { message },
    status,
    statusText: status === 409 ? 'Conflict' : 'Internal Server Error',
    headers: {},
    config: config as AxiosResponse['config'],
  }
}

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))

  if (config.url === '/state' && config.method === 'get') {
    const envelope = loadState()
    envelope.state.notices = loadNotices()
    return ok(config, envelope)
  }

  if (config.url === '/state' && config.method === 'post') {
    const payload = JSON.parse((config.data as string | undefined) ?? '{}') as PersistRequest
    const next = payload.state ?? loadState().state
    const expected = payload.expectedRevision ?? 0
    const result = saveState(next, expected)
    if ('conflict' in result) {
      result.server.state.notices = loadNotices()
      return fail(config, 409, '设备版本已被其他终端更新')
    }
    result.state.notices = loadNotices()
    return ok(config, result)
  }

  if (config.url === '/notices' && config.method === 'post') {
    const payload = JSON.parse((config.data as string | undefined) ?? '{}') as {
      notices: AppState['notices']
    }
    saveNotices(payload.notices ?? [])
    return ok(config, payload.notices ?? [])
  }

  if (config.url === '/actions/reset' && config.method === 'post') {
    return ok(config, resetState())
  }
  if (config.url === '/actions/export' && config.method === 'post') {
    return ok(config, { content: exportSettingsText(loadState().state) })
  }
  if (config.url === '/actions/inject-failure' && config.method === 'post') {
    armWriteFailure()
    return ok(config, { armed: true })
  }
  if (config.url === '/actions/inject-conflict' && config.method === 'post') {
    const payload = JSON.parse((config.data as string | undefined) ?? '{}') as {
      settingId?: string
    }
    armConflict(payload.settingId)
    return ok(config, { armed: true })
  }
  return Promise.reject(new Error(`未实现的本地接口：${config.method} ${config.url}`))
}

export const http = axios.create({
  baseURL: '/api',
  adapter: mockAdapter,
  headers: { 'Content-Type': 'application/json' },
  validateStatus: (status) => status >= 200 && status < 300,
})

export async function fetchState(): Promise<StateEnvelope> {
  const response = await http.get<StateEnvelope>('/state')
  return response.data
}

/**
 * 乐观锁提交。409 时抛出 RevisionConflictError（调用方保留草稿、列出冲突字段）；
 * 5xx 时抛出写入错误（调用方从原批次恢复）。
 */
export async function persistState(
  state: AppState,
  expectedRevision: number,
): Promise<StateEnvelope> {
  try {
    const response = await http.post<StateEnvelope>('/state', { state, expectedRevision })
    return response.data
  } catch (error) {
    // 适配器在浏览器与内存测试环境下都可能给出响应；409 统一识别为版本冲突
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : (error as { response?: { status?: number } })?.response?.status
    if (status === 409) {
      const envelope = (
        axios.isAxiosError(error)
          ? error.response?.data
          : (error as { response?: { data?: StateEnvelope } })?.response?.data
      ) as StateEnvelope
      throw new RevisionConflictError(envelope)
    }
    throw error
  }
}

export async function persistNotices(notices: AppState['notices']): Promise<void> {
  await http.post('/notices', { notices })
}

export async function resetMockState(): Promise<StateEnvelope> {
  const response = await http.post<StateEnvelope>('/actions/reset')
  return response.data
}

export async function exportSettings(): Promise<string> {
  const response = await http.post<{ content: string }>('/actions/export')
  return response.data.content
}

/** 演示故障注入：下一次写入失败 */
export async function injectWriteFailure(): Promise<void> {
  await http.post('/actions/inject-failure')
}

/** 演示并发冲突：下一次写入时服务端先推进装置版本 */
export async function injectConflict(settingId?: string): Promise<void> {
  await http.post('/actions/inject-conflict', { settingId })
}
