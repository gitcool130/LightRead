/** A device-wide minimum interval, shared by every automatic trigger. */
export const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000

interface SchedulerOptions {
  now: () => number
  enabled: () => boolean
  online: () => boolean
  readNextAt: () => number
  writeNextAt: (at: number) => void
  run: () => Promise<unknown>
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
}

export function createAutoSyncScheduler(options: SchedulerOptions) {
  let active = false
  let running = false
  let nextAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerAt = 0

  function clear() {
    if (timer !== null) options.clearTimer(timer)
    timer = null
    timerAt = 0
  }

  function save(at: number) {
    nextAt = at
    options.writeNextAt(at)
  }

  function request() {
    if (!active || running || !options.enabled() || !options.online()) {
      clear()
      return
    }
    const now = options.now()
    if (!nextAt) {
      const saved = options.readNextAt()
      // Fresh installs wait for the first interval; initial/manual sync stays immediate.
      save(Number.isFinite(saved) && saved > 0 ? saved : now + AUTO_SYNC_INTERVAL_MS)
    }
    // A clock moved backwards must not postpone synchronization indefinitely.
    if (nextAt > now + AUTO_SYNC_INTERVAL_MS) save(now + AUTO_SYNC_INTERVAL_MS)
    if (timer !== null && timerAt === nextAt) return
    clear()
    timerAt = nextAt
    timer = options.setTimer(() => {
      timer = null
      timerAt = 0
      if (!active || !options.enabled() || !options.online()) return
      if (options.now() < nextAt) { request(); return }
      // Persist before starting, including failed attempts and app termination.
      save(options.now() + AUTO_SYNC_INTERVAL_MS)
      running = true
      void Promise.resolve().then(options.run).catch(() => {
        // The sync service exposes the error to the UI. Do not retry on every event.
      }).finally(() => {
        running = false
        request()
      })
    }, Math.max(0, nextAt - now))
  }

  return {
    start() { active = true; request() },
    stop() { active = false; clear() },
    request,
    /** Manual synchronization bypasses the timer and starts a new six-hour interval. */
    recordAttempt() {
      save(options.now() + AUTO_SYNC_INTERVAL_MS)
      request()
    },
  }
}
