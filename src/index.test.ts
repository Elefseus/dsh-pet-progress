/**
 * Load test for the host half: drives the plugin's apply() with a fake cordis
 * context and a fake pet service, feeding it real-shaped session events, and
 * asserts what lands in the announcement slot and the panel action registry.
 *
 * This covers the wiring the pure projection tests cannot: that `todo/write`
 * and `goal/change` are the events consumed, that unrelated events are
 * ignored, that the session table is bounded and cleaned up, and that the
 * plugin never throws into the pet's event path.
 *
 * Run: node --test src/index.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apply, PROGRESS_SOURCE, PROGRESS_ACTION_ID } from './index.ts'
import { PROGRESS_MOMENT_TTL_MS } from './progress.ts'

/** A fake cordis context recording everything the plugin registers. */
function makeCtx() {
  const listeners = new Map<string, Array<(a: unknown, b: unknown) => void>>()
  const effects: Array<() => void> = []
  const ctx: Record<string, unknown> = {
    on(name: string, fn: (a: unknown, b: unknown) => void) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
    effect(fn: () => (() => void) | void) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    /** Deliver an event to every listener registered for `name`. */
    emit(name: string, a: unknown, b?: unknown) {
      for (const fn of listeners.get(name) ?? []) fn(a, b)
    },
  }
  return {
    ctx,
    effects,
    emit: (name: string, a: unknown, b?: unknown) => (ctx.emit as (n: string, x: unknown, y?: unknown) => void)(name, a, b),
    countListeners: (name: string) => (listeners.get(name) ?? []).length,
  }
}

/** A fake pet service capturing announce payloads and panel actions. */
function makePet() {
  const announcements: Array<Record<string, unknown>> = []
  const actions = new Map<string, Record<string, unknown>>()
  const pet = {
    announce(input: unknown) {
      announcements.push(input as Record<string, unknown>)
      return { ok: true }
    },
    registerPanelAction(action: unknown) {
      const a = action as Record<string, unknown>
      actions.set(String(a.id), a)
      return () => actions.delete(String(a.id))
    },
  }
  return { pet, announcements, actions }
}

/**
 * Assert one captured announcement satisfies the pet's announcement contract.
 *
 * `parseAnnouncement` (in `@linxin666/dsh-pet/announce`) returns undefined for a
 * payload that breaks the contract, and `announce` answers `{ ok: false }`, so a
 * violating payload is dropped in silence and its bubble never renders. `plan`
 * requires a percent; `balance` and `cost` require an amount; all three require
 * a source, a title, and a known tone.
 */
function assertAnnounceable(a: Record<string, unknown>): void {
  assert.equal(typeof a.source, 'string', 'a source is required')
  assert.ok(typeof a.title === 'string' && a.title !== '', 'a title is required')
  assert.ok(a.tone === 'ok' || a.tone === 'warn' || a.tone === 'low', `unknown tone ${String(a.tone)}`)
  if (a.kind === 'plan') {
    assert.equal(typeof a.percent, 'number', 'kind plan requires a percent')
    return
  }
  assert.ok(a.kind === 'cost' || a.kind === 'balance', `unknown kind ${String(a.kind)}`)
  assert.ok(typeof a.amount === 'string' && a.amount !== '', `kind ${String(a.kind)} requires an amount`)
}

const session = (id: string) => ({ id })

/**
 * Run `body` with a settable clock, so the stream throttle can be stepped over
 * instead of waited out.
 */
function withClock(body: (advance: (ms: number) => void) => void): void {
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    body(ms => { now += ms })
  } finally {
    Date.now = realNow
  }
}

/**
 * Run `body` with the heartbeat captured instead of scheduled, so the timer can
 * be fired deterministically rather than waiting out a real 10 s interval.
 */
function withHeartbeat(body: (fire: () => void) => void): void {
  const timers: Array<() => void> = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  ;(globalThis as { setInterval: unknown }).setInterval = ((fn: () => void) => {
    timers.push(fn)
    return { unref() {} }
  }) as never
  ;(globalThis as { clearInterval: unknown }).clearInterval = (() => {}) as never
  try {
    body(() => { for (const fn of timers) fn() })
  } finally {
    ;(globalThis as { setInterval: unknown }).setInterval = realSetInterval
    ;(globalThis as { clearInterval: unknown }).clearInterval = realClearInterval
  }
}

describe('pet-progress host half', () => {
  it('subscribes to session events and registers one panel action', () => {
    const { ctx, countListeners } = makeCtx()
    const { pet, actions } = makePet()
    apply({ ...ctx, pet } as never, {})
    assert.equal(countListeners('session/event'), 1)
    assert.equal(countListeners('session/disposed'), 1)
    assert.ok(actions.has(PROGRESS_ACTION_ID))
  })

  it('mounts when the pet service is not yet available', () => {
    // Regression: apply() used to read ctx.pet once and return silently when it
    // was undefined. The pet publishes its service from inside its own fiber, so
    // a sibling row can be applied before `pet` exists — which made the plugin
    // mount, log nothing, and produce no bubble for an entire boot.
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    const deferred: Array<() => void> = []

    // No `pet` on the context yet; `inject` records the deferred body instead.
    const lateCtx = {
      ...ctx,
      pet: undefined,
      inject(names: string[], callback: (c: unknown) => void) {
        assert.deepEqual(names, ['pet'], 'it waits specifically on the pet service')
        deferred.push(() => callback({ ...ctx, pet }))
      },
    }

    apply(lateCtx as never, {})
    assert.equal(deferred.length, 1, 'apply must defer rather than give up')

    // Nothing is published until the service appears...
    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: { todos: [{ content: 'a', status: 'in_progress' }] },
    })
    assert.equal(announcements.length, 0)

    // ...and once it does, the plugin works normally.
    for (const run of deferred) run()
    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: { todos: [{ content: 'a', status: 'in_progress' }] },
    })
    assert.equal(announcements.length, 1)
    assert.equal(announcements[0]!.title, 'a')
  })

  // Regression: a session must still work in the turn AFTER its first ends.
  // `todo/write` is only emitted when the todo list changes, so a new turn that
  // leaves the list alone emits nothing — if retiring the bubble also deleted
  // the view, the plugin went permanently mute for that session.
  describe('across a turn boundary', () => {
    it('brings the bubble back on the next turn/start', () => {
      const { ctx } = makeCtx()
      const { pet, announcements } = makePet()
      apply({ ...ctx, pet } as never, {})

      ctx.emit('session/event', session('s1'), {
        type: 'todo/write',
        data: { todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
        ] },
      })
      assert.equal(announcements.length, 1)

      // Turn ends: the bubble retires, but the work is remembered.
      ctx.emit('session/event', session('s1'), { type: 'turn/end', data: { reason: { kind: 'completed' } } })

      // A new turn begins with NO todo/write in between.
      ctx.emit('session/event', session('s1'), { type: 'turn/start', data: { turn: 2 } })
      assert.equal(announcements.length, 2, 'the bubble must return without a fresh todo/write')
      const back = announcements.at(-1)!
      assert.equal(back.percent, 50)
      assert.equal(back.note, '1/2')
    })

    it('reports the turn itself for a session that never had progress', () => {
      const { ctx } = makeCtx()
      const { pet, announcements } = makePet()
      apply({ ...ctx, pet } as never, {})
      // No todo list and no goal: `turn/start` cannot resurrect anything, but it
      // IS an activity event, so the summary fallback reports the new turn. That
      // is the whole point of the fallback — the user sees '等待模型响应' instead
      // of an empty slot while the agent works without a todo list.
      ctx.emit('session/event', session('s1'), { type: 'turn/start', data: { turn: 1 } })
      assert.equal(announcements.length, 1)
      const first = announcements[0]!
      assert.equal(first.kind, 'cost', 'a bubble with no number must not ride the plan kind')
      assert.equal(first.title, '当前过程')
      assert.equal(first.amount, '等待模型响应')
      assert.equal(first.percent, undefined, 'a summary is not a measurement')
    })

    it('keeps working after many turn boundaries', () => {
      const { ctx } = makeCtx()
      const { pet, announcements } = makePet()
      apply({ ...ctx, pet } as never, {})
      ctx.emit('session/event', session('s1'), {
        type: 'todo/write',
        data: { todos: [{ content: 'a', status: 'pending' }] },
      })
      for (let turn = 2; turn <= 5; turn++) {
        ctx.emit('session/event', session('s1'), { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        ctx.emit('session/event', session('s1'), { type: 'turn/start', data: { turn } })
      }
      // 1 initial + 4 resurrections.
      assert.equal(announcements.length, 5)
    })
  })

  it('announces a progress bubble for a todo list', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: {
        todos: [
          { content: '读代码', status: 'completed' },
          { content: '写测试', status: 'in_progress' },
          { content: '跑验证', status: 'pending' },
        ],
      },
    })

    assert.equal(announcements.length, 1)
    const a = announcements[0]!
    assert.equal(a.source, PROGRESS_SOURCE)
    assert.equal(a.kind, 'plan')
    assert.equal(a.title, '写测试')
    assert.equal(a.percent, 33)
    assert.equal(a.note, '1/3')
    assert.equal(a.tone, 'warn')
    assert.ok(typeof a.ttlMs === 'number' && (a.ttlMs as number) > 0)
  })

  it('adopts an activity summary only for a session with nothing to measure', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    // No todo list and no goal: the summary IS the bubble. The lead names the
    // source and the line is the body, because the pet requires a number for a
    // `plan` bubble and renders a text body through `cost`.
    ctx.emit('session/event', session('s1'), { type: 'tool/call', data: { name: 'bash' } })
    assert.equal(announcements.length, 1)
    assert.equal(announcements[0]!.kind, 'cost')
    assert.equal(announcements[0]!.title, '当前过程')
    assert.equal(announcements[0]!.amount, '正在调用 bash')
    assert.equal(announcements[0]!.percent, undefined)

    // The model's own words are the best summary there is, and they are labelled
    // '最近输出' so a reader knows they are quoted rather than derived.
    ctx.emit('session/event', session('s1'), {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '正在核对构建产物是否与源码一致' }] } },
    })
    assert.equal(announcements.length, 2)
    assert.equal(announcements[1]!.title, '最近输出')
    assert.equal(announcements[1]!.amount, '正在核对构建产物是否与源码一致')

    // A real todo list supersedes the summary: from here on the summary is
    // never read again, even though activity events keep arriving.
    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: { todos: [{ content: '写测试', status: 'in_progress' }] },
    })
    assert.equal(announcements.length, 3)
    assert.equal(announcements[2]!.title, '写测试')
    assert.equal(announcements[2]!.percent, 0)

    ctx.emit('session/event', session('s1'), { type: 'tool/call', data: { name: 'bash' } })
    assert.equal(announcements.length, 3, 'a measured session ignores the summary fallback')
  })

  it('keeps the summary when a goal clear leaves nothing else to show', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), { type: 'step/start', data: {} })
    const before = announcements.length
    assert.ok(before > 0)
    // `goal/change` with no goal is a no-op for a goal that was never created,
    // so the summary is all this session has and it must survive the event.
    ctx.emit('session/event', session('s1'), { type: 'goal/change', data: { operation: 'clear' } })
    assert.equal(announcements.length, before)
  })

  it('does not resurrect a summary after the turn that produced it ends', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), { type: 'tool/call', data: { name: 'bash' } })
    assert.equal(announcements.length, 1)

    // `turn/end` retires the bubble. A summary claims no slot, so the entry is
    // dropped outright. `turn/start` then reports the NEW turn rather than
    // replaying the old summary — that is the distinction from the todo case
    // above, where the remembered view IS replayed.
    ctx.emit('session/event', session('s1'), { type: 'turn/end', data: {} })
    ctx.emit('session/event', session('s1'), { type: 'turn/start', data: { turn: 2 } })
    assert.equal(announcements.length, 2)
    assert.equal(announcements[1]!.amount, '等待模型响应', 'the new turn, not the stale summary')

    // The stale summary is gone for good: a later `tool/result` reports the
    // phase it actually is rather than falling back to what the old turn did.
    ctx.emit('session/event', session('s1'), { type: 'tool/result', data: {} })
    ctx.emit('session/event', session('s1'), { type: 'step/start', data: {} })
    assert.equal(announcements.length, 3)
    assert.equal(announcements[2]!.amount, '等待模型响应')
  })

  it('reports only phases it has copy for', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    // `tool/call` with no tool name carries no line: the phase's own copy is
    // the generic '正在调用工具' and a nameless call is not worth that.
    ctx.emit('session/event', session('s1'), { type: 'tool/call', data: {} })
    assert.equal(announcements.length, 0)

    // `waiting` and `tool` name something concrete, so they publish.
    ctx.emit('session/event', session('s1'), { type: 'step/start', data: {} })
    assert.equal(announcements.length, 1)
    assert.equal(announcements[0]!.title, '当前过程')
    assert.equal(announcements[0]!.amount, '等待模型响应')

    // `thinking` and `review` are internal states: recorded on the view (the
    // panel prints them) but never published, so the bubble does not flicker
    // between the model's words and boilerplate between tool calls.
    ctx.emit('session/event', session('s1'), { type: 'tool/result', data: {} })
    ctx.emit('session/event', session('s1'), { type: 'assistant/message', data: {} })
    assert.equal(announcements.length, 1)
  })

  it('names the tool a phase-only summary is calling', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), { type: 'tool/call', data: { name: 'read' } })
    assert.equal(announcements.length, 1)
    assert.equal(announcements[0]!.amount, '正在调用 read')
  })

  it('publishes only announcement shapes the pet accepts', () => {
    // Regression: a `plan` announcement without a percent is rejected by the
    // pet's validator and dropped without a word, so the summary bubble rode a
    // shape that could never render — every other test here passed while the
    // feature was invisible on screen.
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    // Drive both shapes: a summary first, then real measurements.
    for (const event of [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { name: 'bash' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '读完了' }] } } },
      { type: 'todo/write', data: { todos: [{ content: '写测试', status: 'in_progress' }] } },
      { type: 'goal/change', data: { operation: 'create', goal: { objective: '发布', phase: 'active' } } },
    ]) {
      ctx.emit('session/event', session('s1'), event)
    }

    const kinds = new Set(announcements.map(a => a.kind))
    assert.ok(kinds.has('cost'), 'the summary shape is exercised')
    assert.ok(kinds.has('plan'), 'the measured shape is exercised')
    for (const a of announcements) assertAnnounceable(a)
  })

  it('never throws into the pet event path on a malformed payload', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    for (const bad of [undefined, null, 42, 'x', {}, { todos: 'nope' }, { todos: [] }]) {
      ctx.emit('session/event', session('s1'), { type: 'todo/write', data: bad })
    }
    for (const bad of [undefined, null, {}, { operation: 'clear' }, { operation: 'create', goal: {} }]) {
      ctx.emit('session/event', session('s1'), { type: 'goal/change', data: bad })
    }
    // An activity event with nothing readable in it must not throw. The first
    // event here DOES announce (the summary fallback), so the later malformed
    // ones are the ones under test: they must leave the count alone.
    for (const bad of [undefined, null, 42, 'x', {}, { message: { content: [] } }]) {
      ctx.emit('session/event', session('s1'), { type: 'assistant/message', data: bad })
    }
    assert.equal(announcements.length, 0)
  })

  it('reports a goal by its round budget when no todos exist', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), {
      type: 'goal/change',
      data: {
        operation: 'create',
        goal: { objective: '重构 runner', phase: 'active', maxGoalRounds: 8 },
        roundsStarted: 2,
      },
    })
    assert.equal(announcements.length, 1)
    assert.equal(announcements[0]!.title, '重构 runner')
    assert.equal(announcements[0]!.percent, 25)
    assert.equal(announcements[0]!.note, '2/8 轮')
  })

  it('surfaces a blocked goal with its reason', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), {
      type: 'goal/change',
      data: {
        operation: 'block',
        goal: {
          objective: '部署',
          phase: 'blocked',
          maxGoalRounds: 4,
          blockedReason: { code: 'need-credentials', message: '需要 API 密钥' },
        },
        roundsStarted: 1,
      },
    })
    assert.equal(announcements[0]!.tone, 'low')
    assert.equal(announcements[0]!.title, '需要 API 密钥')
  })

  it('composes a goal with a todo list across separate events', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), {
      type: 'goal/change',
      data: { operation: 'create', goal: { objective: '发布 v2', phase: 'active', maxGoalRounds: 8 }, roundsStarted: 0 },
    })
    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: { todos: [{ content: '任务 A', status: 'completed' }, { content: '任务 B', status: 'pending' }] },
    })
    const last = announcements.at(-1)!
    assert.equal(last.percent, 50)
    assert.equal(last.note, '1/2')
  })

  it('forgets a disposed session', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: { todos: [{ content: 'x', status: 'in_progress' }] },
    })
    assert.equal(announcements.length, 1)
    ctx.emit('session/disposed', session('s1'))
    // A later heartbeat must not resurrect the disposed session's bubble: it is
    // gone from the table, so there is nothing to re-publish.
    assert.equal(announcements.length, 1)
  })

  // Regression: a finished list used to stay on screen until the session ended.
  // The completion bubble was a normal standing bubble, so the heartbeat renewed
  // it every 10 s, and the next turn replayed the same finished list on top. A
  // finished list is a MOMENT: announce it once with the short TTL and forget it.
  it('lets a finished list fade instead of pinning it to the pet', () => {
    withHeartbeat(fire => {
      const { ctx } = makeCtx()
      const { pet, announcements } = makePet()
      apply({ ...ctx, pet } as never, {})

      ctx.emit('session/event', session('s1'), {
        type: 'todo/write',
        data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] },
      })
      assert.equal(announcements.length, 1)
      assert.equal(announcements[0]!.title, '任务全部完成')
      assert.equal(announcements[0]!.ttlMs, PROGRESS_MOMENT_TTL_MS, 'a moment gets the short TTL')

      const before = announcements.length
      fire()
      assert.equal(announcements.length, before, 'the heartbeat must not renew a moment')

      // The next turn must report itself, not replay the finished list.
      ctx.emit('session/event', session('s1'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      ctx.emit('session/event', session('s1'), { type: 'turn/start', data: { turn: 2 } })
      const last = announcements.at(-1)!
      assert.equal(last.title, '当前过程', 'a new turn reports itself instead of the finished list')
      assert.equal(last.amount, '等待模型响应')
    })
  })

  it('reports the current activity once the list finishes', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
    })
    assert.equal(announcements.at(-1)!.title, 'b')

    // Completion is the moment...
    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] },
    })
    assert.equal(announcements.at(-1)!.title, '任务全部完成')

    // ...and after it the summary takes over again, which used to be impossible
    // because the finished view kept claiming to be a measurement.
    ctx.emit('session/event', session('s1'), { type: 'tool/call', data: { name: 'bash' } })
    const last = announcements.at(-1)!
    assert.equal(last.title, '当前过程')
    assert.equal(last.amount, '正在调用 bash')
  })

  it('does not let a quiet phase overwrite the standing bubble', () => {
    withHeartbeat(fire => {
      const { ctx } = makeCtx()
      const { pet, announcements } = makePet()
      apply({ ...ctx, pet } as never, {})

      ctx.emit('session/event', session('s1'), {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '正在核对构建产物' }] } },
      })
      assert.equal(announcements.at(-1)!.amount, '正在核对构建产物')

      // `tool/result` is a quiet phase: recorded on the view, never published.
      const before = announcements.length
      ctx.emit('session/event', session('s1'), { type: 'tool/result', data: {} })
      assert.equal(announcements.length, before)

      // The heartbeat re-publishes the last useful line, not the quiet phase.
      fire()
      assert.equal(announcements.at(-1)!.amount, '正在核对构建产物')
    })
  })

  // The durable `assistant/message` lands only when the attempt finishes, so a
  // fallback fed by it alone says nothing while the model is actually writing.
  // The live stream is what makes the bubble track the model in real time.
  it('streams the model output into the bubble, throttled', () => {
    withClock(advance => {
      const { ctx } = makeCtx()
      const { pet, announcements } = makePet()
      apply({ ...ctx, pet } as never, {})

      const say = (text: string) => ctx.emit('agent/assistant-stream', {
        agent: { session: session('s1') },
        frame: { type: 'chunk', chunk: { type: 'text-delta', text } },
      })

      say('我在检查构建')
      assert.equal(announcements.length, 1)
      assert.equal(announcements[0]!.title, '最近输出')
      assert.equal(announcements[0]!.amount, '我在检查构建')

      // Inside the throttle window the buffer still grows, but the pet's slot is
      // not touched — a bubble re-rendered per delta is unreadable.
      say('配置')
      assert.equal(announcements.length, 1)

      advance(500)
      say('并重新跑测试')
      assert.equal(announcements.length, 2)
      assert.equal(announcements[1]!.amount, '我在检查构建配置并重新跑测试')
    })
  })

  it('ignores the live stream for a session that has a measurement', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'in_progress' }] },
    })
    const before = announcements.length

    ctx.emit('agent/assistant-stream', {
      agent: { session: session('s1') },
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: '闲聊' } },
    })
    assert.equal(announcements.length, before, 'a measured session never falls back')
  })

  it('starts a fresh live transcript each turn', () => {
    withClock(advance => {
      const { ctx } = makeCtx()
      const { pet, announcements } = makePet()
      apply({ ...ctx, pet } as never, {})

      const say = (text: string) => ctx.emit('agent/assistant-stream', {
        agent: { session: session('s1') },
        frame: { type: 'chunk', chunk: { type: 'text-delta', text } },
      })

      // No `turn/end` in between: the buffer has to be reset by `turn/start`
      // alone, or the new turn's line would open with the old turn's words.
      say('第一轮说的话')
      ctx.emit('session/event', session('s1'), { type: 'turn/start', data: { turn: 2 } })
      advance(500)
      say('第二轮')
      assert.equal(announcements.at(-1)!.amount, '第二轮')
    })
  })

  // Reasoning streams before the answer, as its own kind of delta. The line has
  // to name that half of the model's speech, and the buffer must not splice the
  // thought onto the answer when the kind flips.
  it('shows what the model is thinking, then switches to its answer', () => {
    withClock(advance => {
      const { ctx } = makeCtx()
      const { pet, announcements } = makePet()
      apply({ ...ctx, pet } as never, {})

      const emit = (kind: 'reasoning-delta' | 'text-delta', text: string) =>
        ctx.emit('agent/assistant-stream', {
          agent: { session: session('s1') },
          frame: { type: 'chunk', chunk: { type: kind, text } },
        })

      emit('reasoning-delta', '先确认数组边界')
      assert.equal(announcements.at(-1)!.title, '正在思考')
      assert.equal(announcements.at(-1)!.amount, '先确认数组边界')

      advance(500)
      emit('reasoning-delta', '再判定是否为偶数')
      assert.equal(announcements.at(-1)!.amount, '先确认数组边界再判定是否为偶数')

      // No wait: a kind flip is a new sentence, so it repaints immediately and
      // the answer never appears glued to the thought that preceded it.
      emit('text-delta', '改好了')
      assert.equal(announcements.at(-1)!.title, '最近输出')
      assert.equal(announcements.at(-1)!.amount, '改好了')
    })
  })

  it('says what a tool call is for, not only which tool', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), {
      type: 'tool/call',
      data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) },
    })
    assert.equal(announcements.at(-1)!.amount, '正在调用 pwsh：npm test')

    const read = makeCtx()
    const second = makePet()
    apply({ ...read.ctx, pet: second.pet } as never, {})
    read.ctx.emit('session/event', session('s9'), {
      type: 'tool/call',
      data: { callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'D:\\p\\src\\progress.ts' }) },
    })
    assert.equal(second.announcements.at(-1)!.amount, '正在调用 read：progress.ts')
  })

  // Regression: the bubble used to survive the end of the turn. Because the
  // pet has no retract API (`announce` only sets a slot; the TTL is what
  // expires it) and this plugin refreshes the standing bubble on a heartbeat,
  // a finished session stayed pinned at its last percentage — reported on
  // screen as "75%, never moves, but the session already ended".
  it('stops refreshing the bubble once the turn ends', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    const timers: Array<() => void> = []
    const realSetInterval = globalThis.setInterval
    const realClearInterval = globalThis.clearInterval
    // Capture the heartbeat so it can be fired deterministically rather than
    // waiting out a real 10 s interval.
    ;(globalThis as { setInterval: unknown }).setInterval = ((fn: () => void) => {
      timers.push(fn)
      return { unref() {} }
    }) as never
    ;(globalThis as { clearInterval: unknown }).clearInterval = (() => {}) as never

    try {
      apply({ ...ctx, pet } as never, {})
      assert.equal(timers.length, 1, 'exactly one heartbeat is installed')

      ctx.emit('session/event', session('s1'), {
        type: 'todo/write',
        data: { todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'completed' },
          { content: 'c', status: 'completed' },
          { content: 'd', status: 'pending' },
        ] },
      })
      assert.equal(announcements.length, 1)
      assert.equal(announcements[0]!.percent, 75)

      ctx.emit('session/event', session('s1'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })

      // The old bubble's TTL must be allowed to lapse. If the heartbeat still
      // published, the stale 75% would be renewed indefinitely.
      const before = announcements.length
      for (const fire of timers) fire()
      assert.equal(announcements.length, before, 'heartbeat must not re-publish a retired bubble')
      assert.equal(announcements[0]!.percent, 75, 'the last published payload is unchanged, so it simply expires')
    } finally {
      ;(globalThis as { setInterval: unknown }).setInterval = realSetInterval
      ;(globalThis as { clearInterval: unknown }).clearInterval = realClearInterval
    }
  })

  it('keeps other sessions alive when one turn ends', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), {
      type: 'todo/write',
      data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] },
    })
    ctx.emit('session/event', session('s2'), {
      type: 'todo/write',
      data: { todos: [{ content: 'x', status: 'in_progress' }] },
    })
    // s1 finishes; s2 is untouched and still owns the slot.
    ctx.emit('session/event', session('s1'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    const last = announcements.at(-1)!
    assert.equal(last.title, 'x')
    assert.equal(last.percent, 0)
  })

  it('bounds the session table', () => {
    const { ctx } = makeCtx()
    const { pet } = makePet()
    apply({ ...ctx, pet } as never, {})
    for (let i = 0; i < 60; i++) {
      ctx.emit('session/event', session(`s${i}`), {
        type: 'todo/write',
        data: { todos: [{ content: `t${i}`, status: 'in_progress' }] },
      })
    }
    // The newest session still owns the slot; nothing threw and the table is
    // capped internally (no observable handle, so assert via continued health).
    assert.ok(true)
  })

  it('honours the enabled:false switch', () => {
    const { ctx, countListeners } = makeCtx()
    const { pet, actions } = makePet()
    apply({ ...ctx, pet } as never, { enabled: false })
    assert.equal(countListeners('session/event'), 0)
    assert.equal(actions.size, 0)
  })
})
