import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTO_SYNC_INTERVAL_MS as SIX_HOURS, createAutoSyncScheduler } from '../src/services/sync/scheduler.ts'

function fixture(savedAt = 0) {
  let now = 1_800_000_000_000
  let saved = savedAt
  let enabled = true
  let online = true
  let calls = 0
  let run = async () => {}
  let serial = 0
  const timers = new Map()
  const make = () => createAutoSyncScheduler({
    now: () => now,
    enabled: () => enabled,
    online: () => online,
    readNextAt: () => saved,
    writeNextAt: at => { saved = at },
    run: async () => { calls++; await run() },
    setTimer: (callback, delay) => {
      const id = ++serial
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimer: id => timers.delete(id),
  })
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const advance = async ms => {
    const end = now + ms
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
      await flush()
    }
    now = end
    await flush()
  }
  return {
    make, advance, flush,
    get now() { return now },
    get saved() { return saved },
    get calls() { return calls },
    get timers() { return timers.size },
    set enabled(v) { enabled = v },
    set online(v) { online = v },
    set run(v) { run = v },
    moveClock(ms) { now += ms },
  }
}

test('settings, reader exit and visibility requests share one six-hour deadline', async () => {
  const f = fixture(), scheduler = f.make()
  scheduler.start()
  const due = f.saved
  for (let i = 0; i < 72; i++) {
    await f.advance(5 * 60_000 - 1)
    for (let j = 0; j < 10; j++) scheduler.request()
    assert.equal(f.calls, 0)
    assert.equal(f.timers, 1)
    assert.equal(f.saved, due)
  }
  await f.advance(72)
  assert.equal(f.calls, 1)
  await f.advance(SIX_HOURS)
  assert.equal(f.calls, 2)
})

test('manual sync can happen before the deadline and postpones the automatic run', async () => {
  const f = fixture(), scheduler = f.make()
  scheduler.start()
  await f.advance(60_000)
  scheduler.recordAttempt() // syncNow starts its work immediately after this call.
  await f.advance(SIX_HOURS - 1)
  assert.equal(f.calls, 0)
  await f.advance(1)
  assert.equal(f.calls, 1)
  assert.equal(f.saved, f.now + SIX_HOURS)
})

test('restart retains the deadline, including a failed automatic attempt', async () => {
  const f = fixture()
  f.run = async () => { throw new Error('temporary network failure') }
  let scheduler = f.make()
  scheduler.start()
  await f.advance(SIX_HOURS)
  assert.equal(f.calls, 1)
  scheduler.stop()
  await f.advance(1_000)
  scheduler = f.make()
  scheduler.start()
  for (let i = 0; i < 100; i++) scheduler.request()
  await f.advance(SIX_HOURS - 1_001)
  assert.equal(f.calls, 1)
  await f.advance(1)
  assert.equal(f.calls, 2)
})

test('offline and disabled automatic sync do no work; manual timing is still recorded', async () => {
  const f = fixture(), scheduler = f.make()
  scheduler.start()
  f.online = false
  await f.advance(SIX_HOURS * 2)
  assert.equal(f.calls, 0)
  f.online = true
  f.enabled = false
  scheduler.request()
  assert.equal(f.timers, 0)
  scheduler.recordAttempt()
  f.enabled = true
  scheduler.request()
  await f.advance(SIX_HOURS - 1)
  assert.equal(f.calls, 0)
  await f.advance(1)
  assert.equal(f.calls, 1)
})

test('a suspended or offline app runs once when it resumes after the deadline', async () => {
  const f = fixture(), scheduler = f.make()
  scheduler.start()
  f.online = false
  scheduler.request()
  await f.advance(SIX_HOURS * 3)
  f.online = true
  for (let i = 0; i < 10; i++) scheduler.request()
  await f.advance(0)
  assert.equal(f.calls, 1)
  assert.equal(f.timers, 1)
})

test('a slow sync is never started concurrently; stop prevents rescheduling', async () => {
  const f = fixture(), scheduler = f.make()
  let finish
  f.run = () => new Promise(resolve => { finish = resolve })
  scheduler.start()
  await f.advance(SIX_HOURS)
  for (let i = 0; i < 20; i++) scheduler.request()
  await f.advance(SIX_HOURS * 2)
  assert.equal(f.calls, 1)
  assert.equal(f.timers, 0)
  scheduler.stop()
  finish()
  await f.flush()
  assert.equal(f.timers, 0)
})

test('an existing due timestamp runs immediately, while malformed state starts a new interval', async () => {
  for (const saved of [NaN, -1, 0]) {
    const f = fixture(saved), scheduler = f.make()
    scheduler.start()
    await f.advance(SIX_HOURS - 1)
    assert.equal(f.calls, 0)
    await f.advance(1)
    assert.equal(f.calls, 1)
  }
  const f = fixture(1_799_999_999_999), scheduler = f.make()
  scheduler.start()
  await f.advance(0)
  assert.equal(f.calls, 1)
})

test('moving the clock backwards cannot postpone sync by more than six hours', async () => {
  const f = fixture(), scheduler = f.make()
  scheduler.start()
  f.moveClock(-7 * 24 * 60 * 60_000)
  scheduler.request()
  await f.advance(SIX_HOURS)
  assert.equal(f.calls, 1)
})
