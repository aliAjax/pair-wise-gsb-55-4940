/* Node 冒烟测试专用：复用与浏览器 mockAdapter 相同的存储语义 */
import {
  armConflict,
  armWriteFailure,
  exportSettingsText,
  loadNotices,
  loadState,
  resetState,
  saveNotices,
  saveState,
} from '../src/services/storage'
import type { AppState } from '../src/types/domain'

export async function runMock(
  method: string,
  url: string,
  rawData?: string | null,
): Promise<{ status: number; data: unknown }> {
  await new Promise((r) => setTimeout(r, 5))

  if (url.endsWith('/state') && method.toLowerCase() === 'get') {
    const envelope = loadState()
    envelope.state.notices = loadNotices()
    return { status: 200, data: envelope }
  }
  if (url.endsWith('/state') && method.toLowerCase() === 'post') {
    const payload = JSON.parse(rawData ?? '{}') as { state?: AppState; expectedRevision?: number }
    const next = payload.state ?? loadState().state
    try {
      const result = saveState(next, payload.expectedRevision ?? 0)
      if ('conflict' in result) {
        result.server.state.notices = loadNotices()
        return { status: 409, data: result.server }
      }
      result.state.notices = loadNotices()
      return { status: 200, data: result }
    } catch (error) {
      return { status: 500, data: { message: (error as Error).message } }
    }
  }
  if (url.endsWith('/notices') && method.toLowerCase() === 'post') {
    const payload = JSON.parse(rawData ?? '{}') as { notices?: AppState['notices'] }
    saveNotices(payload.notices ?? [])
    return { status: 200, data: payload.notices ?? [] }
  }
  if (url.endsWith('/actions/reset')) return { status: 200, data: resetState() }
  if (url.endsWith('/actions/export'))
    return { status: 200, data: { content: exportSettingsText(loadState().state) } }
  if (url.endsWith('/actions/inject-failure')) {
    armWriteFailure()
    return { status: 200, data: { armed: true } }
  }
  if (url.endsWith('/actions/inject-conflict')) {
    const payload = JSON.parse(rawData ?? '{}') as { settingId?: string }
    armConflict(payload.settingId)
    return { status: 200, data: { armed: true } }
  }
  return { status: 404, data: { message: `not found ${method} ${url}` } }
}
