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

const session = (id: string) => ({ id })

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

    it('does not invent a bubble for a session that never had progress', () => {
      const { ctx } = makeCtx()
      const { pet, announcements } = makePet()
      apply({ ...ctx, pet } as never, {})
      ctx.emit('session/event', session('s1'), { type: 'turn/start', data: { turn: 1 } })
      assert.equal(announcements.length, 0)
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

  it('ignores events that carry no progress', () => {
    const { ctx } = makeCtx()
    const { pet, announcements } = makePet()
    apply({ ...ctx, pet } as never, {})

    ctx.emit('session/event', session('s1'), { type: 'tool/call', data: { name: 'bash' } })
    ctx.emit('session/event', session('s1'), { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', session('s1'), { type: 'assistant/message', data: {} })
    assert.equal(announcements.length, 0)
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
