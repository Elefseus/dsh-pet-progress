/**
 * dsh-pet-progress host half.
 *
 * The companion pet tells you what the model is doing RIGHT NOW (its own
 * projection maps session events onto thinking / tool / review phases). It has
 * never been able to tell you how much of the work is LEFT, because the two
 * durable events that carry that (`todo/write`, `goal/change`) are dropped by
 * the pet's projection. This plugin reads them and reports the missing half
 * through the pet's existing plugin contracts, so no pet source is modified:
 *
 *   - `ctx.pet.announce({ source: 'pet-progress', kind: 'plan', ... })` pushes
 *     a progress bubble onto the pet's bubble stack (the `plan` kind renders a
 *     percent bar, which is exactly what a progress report wants);
 *   - `ctx.pet.registerPanelAction({ id: 'pet-progress', ... })` adds a
 *     `进度` button to the hover panel that prints the full todo list, because
 *     the bubble is deliberately a one-line summary.
 *
 * Both contracts are process-local and bounded by the pet itself, so a bug in
 * this plugin degrades to a silent bubble rather than pet breakage. Nothing
 * here writes to the session log or the pet's persisted state.
 *
 * Progress is a STANDING fact rather than a moment, so the bubble is
 * re-published on every contributing event and on a slow heartbeat; the TTL
 * then guarantees a dead plugin's bubble clears itself within one missed cycle.
 * Standing is not the same as permanent, though: `turn/end` retires it (see
 * {@link foldProgressEvent}), because a percentage for work nobody is doing any
 * more is worse than no percentage at all.
 * @module dsh-pet-progress
 */

// Type-only: erased by the build, so the runtime never resolves this package.
// The plugin receives its `Context` from the host; it never constructs one.
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: pulls in the pet's `declare module` augmentation that
// types `ctx.pet`. Also erased at runtime.
import type {} from '@linxin666/dsh-pet'
import {
  announcePayload,
  foldProgressEvent,
  hasLiveProgress,
  readActivity,
  renderBubble,
  PROGRESS_MOMENT_TTL_MS,
  PROGRESS_SOURCE,
  PROGRESS_TTL_MS,
  type ActivitySummary,
  type ProgressView,
  type ProgressBubble,
} from './progress.ts'

// Re-exported for callers that read the plugin's identity off the host half.
export { PROGRESS_SOURCE }

/** The panel action id a click dispatches back on. */
export const PROGRESS_ACTION_ID = 'pet-progress'

/**
 * Heartbeat period. Progress only changes when the agent writes a todo list or
 * the goal advances, but a standing bubble must survive a long quiet stretch
 * (a goal round can run for minutes), so it is refreshed on this cadence
 * rather than relying on the next event to arrive before the TTL expires.
 */
export const PROGRESS_HEARTBEAT_MS = 10_000

/** How many sessions keep independent progress state. */
const MAX_TRACKED_SESSIONS = 24

/** The session face this plugin reads. Only the id is needed: progress is
 * per-session, and a disposed session drops its entry. */
interface SessionLike {
  id: string | number
}

/** Per-session progress, plus the last bubble actually published. */
interface SessionProgress {
  view?: ProgressView
  /** The last rendered bubble, so the heartbeat can re-publish it verbatim. */
  bubble?: ProgressBubble
  /** Epoch ms of the last change, for idle expiry. */
  at: number
}

/**
 * Activity events that describe what the session is doing RIGHT NOW.
 *
 * These are read only when the session has no todo list and no goal — the
 * summary is a fallback, so the plugin does not spend work folding activity for
 * sessions that already have a real measurement. They double as the events that
 * START a session's entry: a session with no todos still needs a view to hang
 * its summary on.
 */
const ACTIVITY_EVENT_TYPES: Record<string, ActivityPhase> = {
  'turn/start': 'waiting',
  'step/start': 'waiting',
  'tool/call': 'tool',
  'tool/result': 'thinking',
  'assistant/message': 'review',
}

/**
 * The phases whose copy is NOT worth a bubble on its own.
 *
 * A summary is only useful while it says something the previous line did not.
 * '正在思考' and '正在阅读输出' arrive several times a turn and describe the
 * agent's internal state rather than the work, so they are recorded on the view
 * (the panel prints them) but never published — otherwise the bubble flickers
 * between the model's own words and boilerplate between every tool call.
 */
const QUIET_PHASES: ReadonlySet<ActivityPhase> = new Set<ActivityPhase>(['thinking', 'review'])

/**
 * Whether a summary is worth claiming the announcement slot for.
 *
 * The model's own words always are — they name the actual work, which is the
 * whole point of the fallback. A phase line only is when it names something
 * concrete the session is blocked on (`waiting`, `tool`); the rest are internal
 * states that would make the bubble flicker between the model's words and
 * boilerplate between every tool call.
 */
function isPublishable(summary: ActivitySummary): boolean {
  return summary.source === 'text' || !QUIET_PHASES.has(summary.phase)
}

/** The phase vocabulary this plugin has copy for. */
type ActivityPhase = 'idle' | 'waiting' | 'thinking' | 'tool' | 'review' | 'done' | 'failed'

/** Plugin config. */
export interface ProgressConfig {
  /** Master switch (default true). */
  enabled?: boolean
  /** Heartbeat period in ms (default {@link PROGRESS_HEARTBEAT_MS}). */
  heartbeatMs?: number
}

export const name = 'pet-progress'

/** The pet service must exist: this plugin is a companion to it, not a
 * standalone surface. Cordis keeps this plugin unloaded until the pet is up. */
export const inject = ['pet']

/**
 * Mount the companion.
 * @param ctx - the cordis context; `ctx.pet` is the pet service.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: ProgressConfig = {}): void {
  // `inject: ['pet']` gates the mount, but the pet service is published by the
  // pet plugin's Service constructor, which runs when ITS fiber starts. A
  // sibling row can therefore have apply() called before ctx.pet exists, and
  // returning here would silently disable the plugin for the whole boot with no
  // error anywhere. So instead of giving up, wait for the service to appear.
  const mount = (pet: PetLike | undefined): void => {
    if (pet === undefined) {
      console.warn('[pet-progress] pet service unavailable; progress bubble disabled')
      return
    }
    mountWith(ctx, pet, config)
  }

  if (ctx.pet !== undefined) {
    mount(ctx.pet)
    return
  }
  // The service is not up yet: mount when it is published.
  ctx.inject(['pet'], (injected: Context) => { mount(injected.pet) })
}

/**
 * The pet service face this plugin uses. Declared structurally so the plugin
 * does not depend on the pet's own type surface at runtime.
 */
interface PetLike {
  announce(input: unknown): unknown
  registerPanelAction(action: unknown): unknown
}

/**
 * Whether the pet refused an announcement. Its validator answers `{ ok: false }`
 * for a payload it cannot accept and the bubble never renders, so this is the
 * only signal that a bubble went missing rather than merely being empty.
 */
function isRejected(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false
}

/** Mount the companion against a resolved pet service. */
function mountWith(ctx: Context, pet: PetLike, config: ProgressConfig): void {
  if (config.enabled === false) return

  const heartbeatMs = typeof config.heartbeatMs === 'number' && Number.isFinite(config.heartbeatMs) && config.heartbeatMs > 0
    ? config.heartbeatMs
    : PROGRESS_HEARTBEAT_MS

  const sessions = new Map<string, SessionProgress>()
  /** The session whose progress owns the single announcement slot. */
  let displaySession: string | undefined
  /** Whether a rejected announcement has already been reported. */
  let warned = false

  /** Publish one bubble into this plugin's announcement slot. */
  const publish = (bubble: ProgressBubble | undefined, ttlMs = Math.max(PROGRESS_TTL_MS, heartbeatMs * 3)): void => {
    if (bubble === undefined) return
    // The wire shape is derived in one place (see `announcePayload`): a bubble
    // the pet's validator cannot accept is dropped without a word, so the
    // rejection is surfaced once instead of looking like a plugin with nothing
    // to say.
    const result = pet.announce(announcePayload(bubble, ttlMs))
    if (!warned && isRejected(result)) {
      warned = true
      console.warn('[pet-progress] the pet rejected the announcement; no bubble will render')
    }
  }

  /**
   * Re-render and publish the current display session's progress. Called after
   * every contributing event and by the heartbeat; publishing an unchanged
   * bubble is how the standing bubble stays alive across the TTL.
   */
  const refresh = (): void => {
    if (displaySession === undefined) return
    const entry = sessions.get(displaySession)
    publish(entry?.bubble)
  }

  /** Trim the table to its bound, dropping the least recently touched. */
  const trim = (): void => {
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of sessions) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      sessions.delete(oldestKey)
    }
  }

  const disposers: Array<() => void> = []

  // Every durable session event arrives here, including the two progress
  // events the pet's own projection ignores. Reading them is pure: the fold
  // returns a new view and the adapter only decides what to publish.
  disposers.push(ctx.on('session/event', (session: SessionLike, event: { type: string; data?: unknown }) => {
    const phase = ACTIVITY_EVENT_TYPES[event.type]
    const isProgress = event.type === 'todo/write' || event.type === 'goal/change' || event.type === 'turn/end'
    if (!isProgress && phase === undefined) return
    const key = String(session.id)
    const entry = sessions.get(key) ?? { at: 0 }

    // A new turn resumes whatever work the last one retired the bubble for. The
    // view is still here, so the bubble comes back without waiting for a
    // `todo/write` that may never arrive (the list only re-emits when it
    // changes). Nothing is resurrected when there is no view to show.
    //
    // Note the fallthrough: `turn/start` is ALSO an activity event (`waiting`),
    // so a session with nothing to measure must go on and report the new turn
    // rather than stopping here. Only a session that actually has a bubble to
    // replay resumes and returns.
    if (event.type === 'turn/start' && entry.bubble !== undefined && hasLiveProgress(entry.view)) {
      displaySession = key
      publish(entry.bubble)
      return
    }

    // The summary is a fallback, so it is only folded for a session that has
    // neither a todo list nor a goal — for everything else the activity event
    // is not even read, which keeps a busy turn from paying for copy it will
    // never render. `turn/end` is excluded: it retires rather than reports.
    if (phase !== undefined && !isProgress) {
      if (hasLiveProgress(entry.view)) return
      const summary = readActivity(readActivityPayload(event, phase))
      if (summary === undefined) return
      adoptSummary(key, entry, summary)
      return
    }

    const fold = foldProgressEvent(entry.view, event.type, event.data)
    if (fold.kind === 'ignore') return

    if (fold.kind === 'clear') {
      // The turn ended or the goal was cleared. The pet's announcement contract
      // has NO retract — a slot is retired only by letting its TTL lapse
      // (`announce()` merely sets the slot; `announcementFresh` expires it). So
      // retiring a bubble means DROPPING the bubble and leaving it out of the
      // heartbeat. Re-publishing even once would restart the TTL and strand a
      // finished turn's percentage on screen.
      //
      // The VIEW is kept only while it still describes moving work, and that
      // distinction is the whole point. A `todo/write` is only emitted when the
      // todo list CHANGES, so a new turn that leaves the list alone re-emits
      // nothing. Deleting a live entry would therefore mute the plugin for the
      // rest of the session: the next turn starts, no todo event ever arrives,
      // and no bubble ever comes back. Retiring the bubble without forgetting
      // the work lets the next `turn/start` re-publish from the view we hold.
      //
      // A FINISHED view has no such claim, and keeping it was the bug behind a
      // bubble that showed 任务全部完成 forever: every later turn replayed the
      // finished list instead of reporting what the session was doing, and the
      // activity fallback was blocked by a list nothing was left in. So a
      // finished list — and any summary standing next to it — is forgotten here,
      // and the next turn starts from its own events.
      if (!hasLiveProgress(entry.view)) {
        sessions.delete(key)
      } else {
        // Keep the bubble too: it is the payload `turn/start` replays, and
        // re-rendering it from the view would be the same pure function anyway.
        sessions.set(key, {
          view: entry.view,
          ...(entry.bubble === undefined ? {} : { bubble: entry.bubble }),
          at: Date.now(),
        })
      }
      if (displaySession === key) displaySession = undefined
      return
    }

    const view = fold.view
    const bubble = renderBubble(view)
    // A MOMENT (the list just finished, the goal just completed) is announced
    // once and then forgotten. Keeping its bubble would let the heartbeat renew
    // it forever, which is exactly how "任务全部完成" came to sit on screen until
    // the session ended; instead it is published with a short TTL and expires.
    const moment = bubble !== undefined && bubble.moment === true
    sessions.set(key, { view, ...(bubble === undefined || moment ? {} : { bubble }), at: Date.now() })
    trim()

    // The most recent progress event owns the single announcement slot: the
    // user is looking at the session that is moving, and the pet bubble stack
    // is a finite column. It is not cleared by an unrelated session going
    // quiet, only by a progress-bearing event from another session.
    displaySession = key
    if (bubble !== undefined) publish(bubble, moment ? PROGRESS_MOMENT_TTL_MS : undefined)
  }))

  /**
   * Record an activity summary for a session that has no todo list and no goal,
   * and publish it if it is worth showing.
   *
   * A summary only ever stands in for progress, so this refuses to overwrite a
   * view that has a todo list or a goal — the caller already checks, but the
   * invariant is re-asserted here so a future caller cannot reintroduce the bug.
   */
  const adoptSummary = (key: string, entry: SessionProgress, summary: ActivitySummary): void => {
    const view: ProgressView = {
      ...(entry.view ?? { total: 0, completed: 0, pending: 0, inProgress: 0, percent: 0 }),
      activity: summary,
    }
    const bubble = renderBubble(view)
    const publishable = isPublishable(summary)
    // The view is always adopted — it is what the panel prints and what a later
    // text-bearing event builds on — but a QUIET phase neither claims the
    // announcement slot nor replaces what is in it. The heartbeat re-publishes
    // whatever bubble is stored here, so storing '正在思考' would silently
    // overwrite the model's own last words a few seconds after they appeared.
    sessions.set(key, {
      view,
      ...(publishable
        ? (bubble === undefined ? {} : { bubble })
        : (entry.bubble === undefined ? {} : { bubble: entry.bubble })),
      at: Date.now(),
    })
    trim()
    if (!publishable) return
    displaySession = key
    if (bubble !== undefined) publish(bubble)
  }

  disposers.push(ctx.on('session/disposed', (session: SessionLike) => {
    const key = String(session.id)
    sessions.delete(key)
    if (displaySession === key) displaySession = undefined
  }))

  // Heartbeat: re-publish the standing bubble so it outlives quiet stretches.
  const timer = setInterval(refresh, heartbeatMs)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref(): void }).unref()
  }
  disposers.push(() => clearInterval(timer))

  // The bubble is a one-line summary on purpose; the panel button is where the
  // full list goes, so a long todo list never crowds the pet's bubble stack.
  // Registration is a wiring step, not a hot path: the pet throws on a
  // malformed id/label or a full row rather than dropping it, and the contract
  // binds the disposer to the registering plugin's own fiber. So it is
  // registered through `ctx.effect`, whose cleanup runs the teardown once.
  ctx.effect(() => {
    const disposeAction = pet.registerPanelAction({
      id: PROGRESS_ACTION_ID,
      label: '进度',
      title: '打印当前会话的完整任务列表',
      order: 10,
      onSelect: () => { printProgress(sessions, displaySession) },
    })

    return () => {
      // Ordered teardown: stop publishing first, then release the pet's slot,
      // then drop the subscriptions and the timer.
      displaySession = undefined
      sessions.clear()
      disposeAction()
      for (const dispose of disposers.splice(0)) dispose()
    }
  })
}

/**
 * Shape an activity event's payload for {@link readActivity}, supplying the
 * phase the event type implies.
 *
 * The phase is NOT on the payload: it is a fact of the event TYPE, and the pet's
 * own projection derives it the same way. Passing it in through the payload keeps
 * `readActivity` a pure function of its input (so it stays testable without the
 * event-type table) and keeps this mapping in the one place that already knows
 * the event types.
 */
function readActivityPayload(event: { type: string; data?: unknown }, phase: ActivityPhase): unknown {
  const data = typeof event.data === 'object' && event.data !== null
    ? event.data as Record<string, unknown>
    : {}
  // A tool call names its tool inline; everything else only needs the phase.
  const name = event.type === 'tool/call' && typeof data.name === 'string' ? data.name : undefined
  return {
    ...data,
    phase,
    ...(name === undefined ? {} : { name }),
  }
}
function printProgress(sessions: Map<string, SessionProgress>, displaySession: string | undefined): void {
  if (displaySession === undefined) {
    console.log('[pet-progress] 当前没有进行中的任务')
    return
  }
  const entry = sessions.get(displaySession)
  if (entry?.view === undefined) {
    console.log('[pet-progress] 当前没有进行中的任务')
    return
  }
  const { view } = entry
  if (view.goal !== undefined) {
    const rounds = view.goal.maxGoalRounds > 0 ? ` (${view.goal.roundsStarted}/${view.goal.maxGoalRounds} 轮)` : ''
    console.log(`[pet-progress] 目标: ${view.goal.objective} — ${view.goal.phase}${rounds}`)
    if (view.goal.blockedReason !== undefined) console.log(`[pet-progress] 受阻原因: ${view.goal.blockedReason}`)
  }
  if (view.total > 0) {
    console.log(`[pet-progress] 任务 ${view.completed}/${view.total} 完成`)
    console.log(`[pet-progress] 进度: ${entry.bubble?.title ?? ''}`)
  }
  // With neither a todo list nor a goal there is no measurement to print, only
  // the summary — and saying THAT is more useful than printing nothing, because
  // "no list was written" is exactly the case a user is trying to diagnose.
  if (view.total === 0 && view.goal === undefined) {
    if (view.activity === undefined) {
      console.log('[pet-progress] 当前没有进行中的任务')
      return
    }
    const from = view.activity.source === 'text' ? '模型最近输出' : '当前活动'
    console.log(`[pet-progress] 无任务列表；${from}: ${view.activity.line}`)
  }
}
