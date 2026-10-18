/**
 * 同步对外接口 (设置页 / App 壳调用). 实现在 engine.ts.
 * 导出签名是 UI 依赖的契约, 不要改.
 */
import { reactive } from 'vue'
import type { SyncRemote, SyncResult } from './types'
import { runSync } from './engine.ts'
import { createDexieSyncStore, type SyncStore } from './baseline.ts'
import { createWebdavRemote } from './webdavRemote.ts'
import { createAccountRemote, isAccountUnauthorized } from './accountRemote.ts'
import { deviceName, trackSync, waitForSync } from './shared.ts'
import { settingsSyncPort } from './settingsTracker.ts'
import { readingLogSyncPort } from '../readingLog.ts'
import { accountApiBase, accountState, clearLocalLogin, isLoggedIn } from '../account.ts'
import { getStorage } from '../../storage'
import { useSettings } from '../../stores/settings'
import { useLibrary } from '../../stores/library'
import { t } from '../../i18n'
import { AUTO_SYNC_INTERVAL_MS, createAutoSyncScheduler } from './scheduler.ts'

const STATE_KEY = 'lightread-sync-state'

function loadLastSyncAt(): number {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    const n = raw ? Number(JSON.parse(raw).lastSyncAt) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export const syncState = reactive({
  running: false,
  /** 当前阶段文案 (已经过 t()) */
  message: '',
  /** 上次成功同步的时间, 0 为从未 */
  lastSyncAt: loadLastSyncAt(),
  lastError: '',
  lastResult: null as SyncResult | null,
})

let store: SyncStore | null = null
const syncStore = () => (store ??= createDexieSyncStore())

/** 本机的同步设备 id (互传也用它标识设备) */
export const localDeviceId = (): Promise<string> => syncStore().getDeviceId()

/**
 * WebDAV 已可用: 地址已填写, 且填了账号时也有密码.
 * (设置同步可能只带来地址和账号, 密码要在发送方开启「同步密码与密钥」才会过来; 缺密码时不去连, 免得报认证失败)
 */
export function webdavSyncConfigured(): boolean {
  const s = useSettings()
  return !!s.webdavUrl.trim() && (!s.webdavUser.trim() || !!s.webdavPass)
}

/** 有可用的同步目标 (已登录轻阅账号或已填写 WebDAV) */
export function syncConfigured(): boolean {
  return isLoggedIn() || webdavSyncConfigured()
}

let inflight: Promise<SyncResult> | null = null

/** 多个远端的结果相加; 仅元数据的书数取最后一个远端 (它已看到前面远端落地的书), 设备数取最大 */
function combineResults(a: SyncResult | null, b: SyncResult): SyncResult {
  if (!a) return { ...b }
  return {
    applied: a.applied + b.applied,
    downloadedBooks: a.downloadedBooks + b.downloadedBooks,
    uploadedFiles: a.uploadedFiles + b.uploadedFiles,
    pendingBooks: b.pendingBooks,
    devices: Math.max(a.devices, b.devices),
    settingsApplied: (a.settingsApplied ?? 0) + (b.settingsApplied ?? 0),
  }
}

interface SyncTarget {
  remote: SyncRemote
  syncFiles: boolean
  /** 账号远端所用的 token (401 时据此清除本地登录) */
  token?: string
}

function accountTarget(): SyncTarget | null {
  if (!isLoggedIn()) return null
  const token = accountState.token
  return {
    remote: createAccountRemote({ base: accountApiBase(), token, accountId: accountState.account!.id }, undefined, t),
    syncFiles: false,
    token,
  }
}

function webdavTarget(): SyncTarget | null {
  if (!webdavSyncConfigured()) return null
  const settings = useSettings()
  return {
    remote: createWebdavRemote(
      { url: settings.webdavUrl, user: settings.webdavUser, pass: settings.webdavPass },
      undefined,
      t,
    ),
    syncFiles: settings.webdavSyncFiles,
  }
}

/**
 * 本次要同步的远端, 按顺序: 先轻阅账号, 再 WebDAV (都配置时依次各跑一次, 共用本机基线).
 * WebDAV 在账号同步之后才判断: 新设备登录账号后, 设置同步可能刚带来 WebDAV 配置, 同一次同步里就能用上.
 */
const syncTargetSteps: Array<() => SyncTarget | null> = [accountTarget, webdavTarget]

/** 本次同步的设置端口; 本机关闭了「同步设置」时为 undefined (不发出也不落地) */
function settingsPort() {
  const settings = useSettings()
  if (!settings.syncSettings) return undefined
  return settingsSyncPort(settings.syncSecrets) ?? undefined
}

/**
 * 立即同步; 正在同步时等待当前这次结束并返回其结果. 失败抛错, 同时写入 syncState.lastError.
 * 已登录账号与已填 WebDAV 时依次同步两者; 一个失败仍会尝试另一个, 最后抛出第一个错误.
 */
export async function syncNow(): Promise<SyncResult> {
  if (inflight) return inflight
  inflight = trackSync((async () => {
    syncState.running = true
    syncState.message = ''
    try {
      if (!syncConfigured()) throw new Error(t('sync.err.notConfigured'))
      autoScheduler.recordAttempt()
      const library = useLibrary()
      const storage = await getStorage()
      let result: SyncResult | null = null
      let firstError: unknown = null
      for (const step of syncTargetSteps) {
        const target = step()
        if (!target) continue
        try {
          const r = await runSync({
            storage,
            remote: target.remote,
            store: syncStore(),
            syncFiles: target.syncFiles,
            deviceName: deviceName(),
            app: __APP_VERSION__,
            t,
            onProgress: msg => { syncState.message = msg },
            deleteBook: id => library.removeBook(id),
            readingLog: readingLogSyncPort(),
            settings: settingsPort(),
          })
          result = combineResults(result, r)
        } catch (err) {
          // 会话失效: 清除本地登录 (设置页随之回到登录表单), 错误照常报告
          if (target.token !== undefined && isAccountUnauthorized(err)) clearLocalLogin(target.token)
          console.warn('[sync] failed', target.remote.kind, err)
          firstError ??= err
        }
      }
      // 部分远端失败时, 成功的那次也可能已改动本地库
      await library.refresh()
      if (firstError || !result) throw firstError
      syncState.lastSyncAt = Date.now()
      syncState.lastResult = result
      syncState.lastError = ''
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify({ lastSyncAt: syncState.lastSyncAt }))
      } catch { /* 存储不可用时只影响展示 */ }
      return result
    } catch (err) {
      syncState.lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      syncState.running = false
      syncState.message = ''
    }
  })())
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

const SCHEDULE_KEY = 'lightread-sync-schedule'
const autoScheduler = createAutoSyncScheduler({
  now: () => Date.now(),
  enabled: () => {
    try { return useSettings().webdavSyncAuto && syncConfigured() }
    catch { return false } // pinia 未就绪
  },
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  readNextAt: () => {
    try {
      const saved = Number(localStorage.getItem(SCHEDULE_KEY))
      if (Number.isFinite(saved) && saved > 0) return saved
    } catch { /* 无法持久化时仍在本次会话中限频 */ }
    return syncState.lastSyncAt > 0 ? syncState.lastSyncAt + AUTO_SYNC_INTERVAL_MS : 0
  },
  writeNextAt: at => {
    try { localStorage.setItem(SCHEDULE_KEY, String(at)) }
    catch { /* 无法持久化时仍在本次会话中限频 */ }
  },
  run: syncNow,
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: timer => clearTimeout(timer),
})

/** 所有自动入口共用 6 小时间隔; 设置变更、退出阅读或切后台不会绕过它。 */
export function requestAutoSync(_reason: string): void {
  autoScheduler.request()
}

/** 到期自动同步; 后台挂起时，在重新进入前台或恢复网络后检查是否到期。 */
export function startAutoSync(): () => void {
  const onVisibility = () => requestAutoSync('visibility')
  const onOnline = () => requestAutoSync('online')
  try {
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOnline)
    autoScheduler.start()
  } catch (err) {
    syncState.lastError = err instanceof Error ? err.message : String(err)
  }
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOnline)
    autoScheduler.stop()
  }
}

/** 等正在进行的同步结束 (不论成败) */
export { waitForSync }

/** 清除本地基线; 下次同步 (各远端) 按首次同步处理: 只并集, 不删除 */
export async function resetSyncBaseline(): Promise<void> {
  // 正在同步时等它结束, 否则它会把旧基线写回去
  await waitForSync()
  await syncStore().clearBaseline()
}
