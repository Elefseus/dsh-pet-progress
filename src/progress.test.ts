/**
 * Tests for the progress projection. These pin the three properties the
 * feature lives or dies on: the bar never over-reports completed work, a
 * blocked goal always speaks up, and a malformed payload never reaches the
 * pet's bubble surface.
 *
 * Run with the bundled Node (no install needed):
 *   node --test src/progress.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compactText,
  foldProgressEvent,
  foldTodos,
  goalPercent,
  renderBubble,
  PROGRESS_AMOUNT_MAX,
  PROGRESS_TITLE_MAX,
  type ProgressView,
} from './progress.ts'

const todos = (...statuses: Array<'pending' | 'in_progress' | 'completed'>) =>
  statuses.map((status, i) => ({ content: `任务 ${i + 1}`, status }))

describe('foldTodos', () => {
  it('counts each status and derives the percentage', () => {
    const view = foldTodos(todos('completed', 'completed', 'in_progress', 'pending'))
    assert.deepEqual(view, {
      total: 4, completed: 2, inProgress: 1, pending: 1, percent: 50, activeTodo: '任务 3',
    })
  })

  it('names the active todo when exactly one is in progress', () => {
    const view = foldTodos(todos('completed', 'in_progress'))
    assert.equal(view?.activeTodo, '任务 2')
  })

  it('names no active todo when several are in progress', () => {
    // Guessing which of two parallel tasks to name would be a lie; the bar
    // still reports the count.
    const view = foldTodos(todos('in_progress', 'in_progress'))
    assert.equal(view?.activeTodo, undefined)
    assert.equal(view?.total, 2)
    assert.equal(view?.inProgress, 2)
    assert.equal(view?.percent, 0)
  })

  it('refuses an empty or malformed list instead of blanking a standing bubble', () => {
    assert.equal(foldTodos([]), undefined)
    assert.equal(foldTodos(undefined), undefined)
    assert.equal(foldTodos('nope'), undefined)
    assert.equal(foldTodos([{ content: '   ', status: 'completed' }]), undefined)
  })

  it('treats an unknown status as not-done, never as completed', () => {
    // A future status the projection has not learned must not inflate the bar.
    const view = foldTodos([{ content: 'x', status: 'deferred' }])
    assert.equal(view?.total, 1)
    assert.equal(view?.completed, 0)
    assert.equal(view?.pending, 1)
    assert.equal(view?.percent, 0)
  })

  it('is 100 only when every item is done', () => {
    assert.equal(foldTodos(todos('completed', 'completed'))?.percent, 100)
    assert.equal(foldTodos(todos('completed', 'pending'))?.percent, 50)
  })
})

describe('foldProgressEvent', () => {
  it('ignores events that carry no progress', () => {
    assert.equal(foldProgressEvent(undefined, 'tool/call', {}).kind, 'ignore')
    assert.equal(foldProgressEvent(undefined, 'turn/start', {}).kind, 'ignore')
  })

  it('keeps the goal half when a todo snapshot arrives', () => {
    const goal = { objective: '发布 v2', phase: 'active' as const, maxGoalRounds: 8 }
    const first = foldProgressEvent(undefined, 'goal/change', { operation: 'edit', goal, roundsStarted: 2 })
    assert.equal(first.kind, 'view')
    const prev = (first as { view: ProgressView }).view

    const second = foldProgressEvent(prev, 'todo/write', { todos: todos('completed', 'pending') })
    assert.equal(second.kind, 'view')
    const next = (second as { view: ProgressView }).view
    assert.equal(next.goal?.objective, '发布 v2')
    assert.equal(next.total, 2)
  })

  it('keeps todo progress when the goal is cleared', () => {
    const prev: ProgressView = {
      total: 3, completed: 1, pending: 2, inProgress: 0, percent: 33,
      goal: { objective: 'g', phase: 'active', maxGoalRounds: 4, roundsStarted: 1 },
    }
    const out = foldProgressEvent(prev, 'goal/change', { operation: 'clear' })
    assert.equal(out.kind, 'view')
    const view = (out as { view: ProgressView }).view
    assert.equal(view.goal, undefined)
    assert.equal(view.total, 3)
  })

  it('clears outright when a goal alone is cleared', () => {
    const prev: ProgressView = {
      total: 0, completed: 0, pending: 0, inProgress: 0, percent: 0,
      goal: { objective: 'g', phase: 'active', maxGoalRounds: 4, roundsStarted: 1 },
    }
    assert.equal(foldProgressEvent(prev, 'goal/change', { operation: 'clear' }).kind, 'clear')
  })

  it('reads the goal out of a snapshot change', () => {
    const out = foldProgressEvent(undefined, 'goal/change', {
      operation: 'create',
      goal: { objective: '重构 runner', phase: 'active', maxGoalRounds: 8 },
      roundsStarted: 3,
    })
    assert.equal(out.kind, 'view')
    const view = (out as { view: ProgressView }).view
    assert.equal(view.goal?.objective, '重构 runner')
    assert.equal(view.goal?.maxGoalRounds, 8)
    assert.equal(view.goal?.roundsStarted, 3)
    assert.equal(view.percent, 38)
  })

  it('drops a goal payload with no objective', () => {
    assert.equal(foldProgressEvent(undefined, 'goal/change', { operation: 'create', goal: { phase: 'active' } }).kind, 'ignore')
  })

  // Regression: a finished turn used to leave its last snapshot standing, so a
  // session stopped at "2/3" showed 75% forever (the heartbeat kept the bubble
  // alive). Progress describes work that is moving; `turn/end` is the moment
  // that stops being true.
  describe('turn/end', () => {
    const withTodos: ProgressView = {
      total: 4, completed: 3, pending: 1, inProgress: 0, percent: 75,
    }

    it('retires the bubble even when work was left undone', () => {
      assert.equal(foldProgressEvent(withTodos, 'turn/end', { turn: 1, reason: { kind: 'completed' } }).kind, 'clear')
    })

    it('retires on an aborted turn too', () => {
      assert.equal(foldProgressEvent(withTodos, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }).kind, 'clear')
    })

    it('retires a fully-completed turn rather than pinning it at 100', () => {
      const done: ProgressView = { total: 3, completed: 3, pending: 0, inProgress: 0, percent: 100 }
      assert.equal(foldProgressEvent(done, 'turn/end', {}).kind, 'clear')
    })

    it('retires a goal-view turn', () => {
      const goalView: ProgressView = {
        total: 0, completed: 0, pending: 0, inProgress: 0, percent: 40,
        goal: { objective: 'g', phase: 'active', maxGoalRounds: 8, roundsStarted: 3 },
      }
      assert.equal(foldProgressEvent(goalView, 'turn/end', {}).kind, 'clear')
    })

    it('is harmless when there was nothing to retire', () => {
      assert.equal(foldProgressEvent(undefined, 'turn/end', {}).kind, 'clear')
    })
  })
})

describe('goalPercent', () => {
  it('measures the round budget', () => {
    assert.equal(goalPercent({ objective: 'g', phase: 'active', maxGoalRounds: 8, roundsStarted: 4 }), 50)
  })
  it('is 100 when complete and 0 without a budget', () => {
    assert.equal(goalPercent({ objective: 'g', phase: 'complete', maxGoalRounds: 8, roundsStarted: 3 }), 100)
    assert.equal(goalPercent({ objective: 'g', phase: 'active', maxGoalRounds: 0, roundsStarted: 3 }), 0)
  })
  it('never exceeds 100 when rounds overshoot the budget', () => {
    assert.equal(goalPercent({ objective: 'g', phase: 'active', maxGoalRounds: 2, roundsStarted: 9 }), 100)
  })
})

describe('renderBubble', () => {
  it('leads with the active todo and counts the rest', () => {
    const view = foldTodos(todos('completed', 'in_progress', 'pending'))!
    const bubble = renderBubble(view)!
    assert.equal(bubble.title, '任务 2')
    assert.equal(bubble.percent, 33)
    assert.equal(bubble.note, '1/3')
    assert.equal(bubble.tone, 'warn')
  })

  it('announces completion in green', () => {
    const bubble = renderBubble(foldTodos(todos('completed', 'completed'))!)!
    assert.equal(bubble.percent, 100)
    assert.equal(bubble.note, '2/2')
    assert.equal(bubble.tone, 'ok')
  })

  it('lets a blocked goal outrank a healthy todo list and says why', () => {
    const view: ProgressView = {
      ...foldTodos(todos('completed', 'pending'))!,
      goal: { objective: 'g', phase: 'blocked', maxGoalRounds: 8, roundsStarted: 2, blockedReason: '需要 API 密钥' },
    }
    const bubble = renderBubble(view)!
    assert.equal(bubble.tone, 'low')
    assert.equal(bubble.title, '需要 API 密钥')
  })

  it('reports a goal by its round budget when there are no todos', () => {
    const bubble = renderBubble({
      total: 0, completed: 0, pending: 0, inProgress: 0, percent: 25,
      goal: { objective: '重构 runner', phase: 'active', maxGoalRounds: 8, roundsStarted: 2 },
    })!
    assert.equal(bubble.title, '重构 runner')
    assert.equal(bubble.percent, 25)
    assert.equal(bubble.note, '2/8 轮')
    assert.equal(bubble.tone, 'warn')
  })

  it('reports an activity summary as a body led by its source', () => {
    // A state, not a measurement, so the line is the bubble's BODY — `amount`,
    // which the pet renders verbatim — and the lead names where it came from.
    // There is no percent: the pet's contract rejects a `plan` without one, so a
    // summary must ride the `cost` shape instead (see the host-half adapter).
    const view: ProgressView = {
      total: 0, completed: 0, pending: 0, inProgress: 0, percent: 0,
      activity: { line: '正在调用 bash', source: 'phase', phase: 'tool' },
    }
    const bubble = renderBubble(view)!
    assert.equal(bubble.title, '当前过程')
    assert.equal(bubble.amount, '正在调用 bash')
    assert.equal(bubble.percent, undefined)

    const quoted = renderBubble({
      ...view,
      activity: { line: '读完了', source: 'text', phase: 'review' },
    })!
    assert.equal(quoted.title, '最近输出')
    assert.equal(quoted.amount, '读完了')

    const long = renderBubble({
      ...view,
      activity: { line: '字'.repeat(400), source: 'text', phase: 'review' },
    })!
    assert.ok(long.amount!.length <= PROGRESS_AMOUNT_MAX)
  })

  it('says nothing when there is nothing to report', () => {
    assert.equal(renderBubble(undefined), undefined)
    assert.equal(renderBubble({ total: 0, completed: 0, pending: 0, inProgress: 0, percent: 0 }), undefined)
  })
})

describe('compactText', () => {
  it('collapses whitespace and elides past the bound', () => {
    assert.equal(compactText('  a\n\n b ', 40), 'a b')
    const long = compactText('word '.repeat(40), 20)
    assert.ok(long.length <= 20)
    assert.ok(long.endsWith('…'))
  })

  it('keeps every title inside the announce contract bound', () => {
    // The pet truncates at its own bound anyway; staying under it means the
    // bubble reads as written rather than being cut mid-word by the transport.
    const view = foldTodos([{ content: 'x'.repeat(400), status: 'in_progress' }])!
    assert.ok(renderBubble(view)!.title.length <= PROGRESS_TITLE_MAX)
  })
})
