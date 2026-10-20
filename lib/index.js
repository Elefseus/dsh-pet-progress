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
                                                  
// Side-effect type import: pulls in the pet's `declare module` augmentation that
// types `ctx.pet`. Also erased at runtime.
                                        
import {
  announcePayload,
  foldProgressEvent,
  hasLiveProgress,
  liveTextLine,
  readActivity,
  renderBubble,
  PROGRESS_MOMENT_TTL_MS,
  PROGRESS_SOURCE,
  PROGRESS_TTL_MS,
                       
                    
                      
} from './progress.js'

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

/**
 * Minimum spacing between two stream-driven bubble updates.
 *
 * The model streams dozens of deltas a second and the bubble is one line, so
 * publishing per delta would re-render the pet for changes the reader cannot
 * follow. 400 ms is fast enough to feel live and slow enough to read.
 */
const STREAM_PUBLISH_MS = 400

/**
 * How much live text is kept per turn.
 *
 * Only the tail is ever shown (`liveTextLine`), so this bound is about memory
 * rather than display: a long turn would otherwise grow the buffer without limit.
 * 600 characters is several times the 120-character window, which leaves the line
 * stable when a delta lands mid-word.
 */
const STREAM_BUFFER_MAX = 600

/** How many sessions keep independent progress state. */
const MAX_TRACKED_SESSIONS = 24

/** The session face this plugin reads. Only the id is needed: progress is
 * per-session, and a disposed session drops its entry. */
                       
                     
 

/** Per-session progress, plus the last bubble actually published. */
                           
                     
                                                                               
                         
     
                                                                               
                                                                               
                                                                             
     
                 
     
                                                           
    
                                                                               
                                                                            
     
                                   
                                                                               
                   
                                                      
            
 

/**
 * Activity events that describe what the session is doing RIGHT NOW.
 *
 * These are read only when the session has no todo list and no goal — the
 * summary is a fallback, so the plugin does not spend work folding activity for
 * sessions that already have a real measurement. They double as the events that
 * START a session's entry: a session with no todos still needs a view to hang
 * its summary on.
 */
const ACTIVITY_EVENT_TYPES                                = {
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
const QUIET_PHASES                             = new Set               (['thinking', 'review'])

/**
 * Whether a summary is worth claiming the announcement slot for.
 *
 * The model's own words always are — they name the actual work, which is the
 * whole point of the fallback. A phase line only is when it names something
 * concrete the session is blocked on (`waiting`, `tool`); the rest are internal
 * states that would make the bubble flicker between the model's words and
 * boilerplate between every tool call.
 */
function isPublishable(summary                 )          {
  return summary.source !== 'phase' || !QUIET_PHASES.has(summary.phase)
}

/** The phase vocabulary this plugin has copy for. */
                                                                                            

/** Plugin config. */
                                 
                                      
                   
                                                                        
                      
 

export const name = 'pet-progress'

/** The pet service must exist: this plugin is a companion to it, not a
 * standalone surface. Cordis keeps this plugin unloaded until the pet is up. */
export const inject = ['pet']

/**
 * Mount the companion.
 * @param ctx - the cordis context; `ctx.pet` is the pet service.
 * @param config - plugin config.
 */
export function apply(ctx         , config                 = {})       {
  // `inject: ['pet']` gates the mount, but the pet service is published by the
  // pet plugin's Service constructor, which runs when ITS fiber starts. A
  // sibling row can therefore have apply() called before ctx.pet exists, and
  // returning here would silently disable the plugin for the whole boot with no
  // error anywhere. So instead of giving up, wait for the service to appear.
  const mount = (pet                     )       => {
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
  ctx.inject(['pet'], (injected         ) => { mount(injected.pet) })
}

/**
 * The pet service face this plugin uses. Declared structurally so the plugin
 * does not depend on the pet's own type surface at runtime.
 */
                   
                                   
                                               
 

/**
 * Whether the pet refused an announcement. Its validator answers `{ ok: false }`
 * for a payload it cannot accept and the bubble never renders, so this is the
 * only signal that a bubble went missing rather than merely being empty.
 */
function isRejected(result         )          {
  return typeof result === 'object' && result !== null && (result                    ).ok === false
}

/** Mount the companion against a resolved pet service. */
function mountWith(ctx         , pet         , config                )       {
  if (config.enabled === false) return

  const heartbeatMs = typeof config.heartbeatMs === 'number' && Number.isFinite(config.heartbeatMs) && config.heartbeatMs > 0
    ? config.heartbeatMs
    : PROGRESS_HEARTBEAT_MS

  const sessions = new Map                         ()
  /** The session whose progress owns the single announcement slot. */
  let displaySession                    
  /** Whether a rejected announcement has already been reported. */
  let warned = false

  /** Publish one bubble into this plugin's announcement slot. */
  const publish = (bubble                            , ttlMs = Math.max(PROGRESS_TTL_MS, heartbeatMs * 3))       => {
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
  const refresh = ()       => {
    if (displaySession === undefined) return
    const entry = sessions.get(displaySession)
    publish(entry?.bubble)
  }

  /** Trim the table to its bound, dropping the least recently touched. */
  const trim = ()       => {
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      let oldestKey                    
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

  const disposers                    = []

  // Every durable session event arrives here, including the two progress
  // events the pet's own projection ignores. Reading them is pure: the fold
  // returns a new view and the adapter only decides what to publish.
  disposers.push(ctx.on('session/event', (session             , event                                  ) => {
    const phase = ACTIVITY_EVENT_TYPES[event.type]
    const isProgress = event.type === 'todo/write' || event.type === 'goal/change' || event.type === 'turn/end'
    if (!isProgress && phase === undefined) return
    const key = String(session.id)
    const entry = sessions.get(key) ?? { at: 0 }

    // A new turn starts a new live transcript. Appending to the last turn's
    // buffer would splice two turns' text together the moment the model starts
    // writing again, and the tail would open with the previous turn's words.
    if (event.type === 'turn/start') {
      entry.stream = undefined
      entry.streamKind = undefined
      entry.streamAt = undefined
    }

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

  // The durable `assistant/message` only lands once an attempt finishes, which is
  // exactly when its text stops being news. `agent/assistant-stream` is the live
  // publication the pet's own projection reads for the same reason: it carries
  // the model's deltas while they are being written. Buffering them per turn and
  // reporting the tail is what makes the fallback track the model in real time
  // instead of jumping one long line at the end of each step.
  //
  // Gated like every other activity read: a session with a todo list or a goal has
  // a measurement, and the summary must never displace it.
  disposers.push(ctx.on('agent/assistant-stream', (payload         ) => {
    const live = readLiveDelta(payload)
    if (live === undefined) return
    const { key, text, kind } = live
    const entry                  = sessions.get(key) ?? { at: 0 }
    if (hasLiveProgress(entry.view)) return

    // A thought and an answer are different sentences: when the model stops
    // reasoning and starts writing, the new delta is not a continuation of the
    // old line, so the buffer — and the throttle window — start over instead of
    // concatenating one into the other.
    const continuing = entry.streamKind === kind
    const stream = ((continuing ? entry.stream ?? '' : '') + text).slice(-STREAM_BUFFER_MAX)
    const line = liveTextLine(stream)
    if (line === undefined) return

    const now = Date.now()
    const streamAt = continuing ? entry.streamAt : undefined
    const next                  = { ...entry, stream, streamKind: kind, at: now }
    sessions.set(key, next)

    // Two doors before the pet's slot is touched: the line must actually have
    // changed (a delta that only extends a token already on screen does not), and
    // it must be at least STREAM_PUBLISH_MS since the last stream publish.
    if (continuing && entry.view?.activity?.line === line) return
    if (streamAt !== undefined && now - streamAt < STREAM_PUBLISH_MS) return
    next.streamAt = now
    adoptSummary(key, next, {
      line,
      source: kind,
      phase: kind === 'reasoning' ? 'thinking' : 'review',
    })
  }))

  /**
   * Record an activity summary for a session that has no todo list and no goal,
   * and publish it if it is worth showing.
   *
   * A summary only ever stands in for progress, so this refuses to overwrite a
   * view that has a todo list or a goal — the caller already checks, but the
   * invariant is re-asserted here so a future caller cannot reintroduce the bug.
   */
  const adoptSummary = (key        , entry                 , summary                 )       => {
    const view               = {
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
      // The live buffer and its publish clock belong to the turn, not to this
      // summary, so a stream-driven update survives the rewrite that publishes it.
      ...(entry.stream === undefined ? {} : { stream: entry.stream }),
      ...(entry.streamKind === undefined ? {} : { streamKind: entry.streamKind }),
      ...(entry.streamAt === undefined ? {} : { streamAt: entry.streamAt }),
      at: Date.now(),
    })
    trim()
    if (!publishable) return
    displaySession = key
    if (bubble !== undefined) publish(bubble)
  }

  disposers.push(ctx.on('session/disposed', (session             ) => {
    const key = String(session.id)
    sessions.delete(key)
    if (displaySession === key) displaySession = undefined
  }))

  // Heartbeat: re-publish the standing bubble so it outlives quiet stretches.
  const timer = setInterval(refresh, heartbeatMs)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer                     ).unref()
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
function readActivityPayload(event                                  , phase               )          {
  const data = typeof event.data === 'object' && event.data !== null
    ? event.data                           
    : {}
  // A tool call names its tool inline; everything else only needs the phase.
  const name = event.type === 'tool/call' && typeof data.name === 'string' ? data.name : undefined
  return {
    ...data,
    phase,
    ...(name === undefined ? {} : { name }),
  }
}
/**
 * Read one `agent/assistant-stream` publication down to the two facts this
 * plugin needs: which session is speaking, and the delta it just said.
 *
 * The payload is `{ agent: { session }, frame }` where a frame is only useful
 * when it is a `chunk` carrying a non-empty `text-delta`. The other chunk kinds
 * (reasoning deltas, tool-call deltas, start/end) are deliberately skipped: this
 * line is the model's OUTPUT, and a reasoning delta is deliberation the pet's
 * own bubble already covers with its phase.
 *
 * Read structurally: the plugin never imports the agent's frame types, so a
 * shape change degrades to "no live line" rather than to a thrown listener.
 */
function readLiveDelta(payload         )                                                                        {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload                           

  const agent = record.agent
  if (typeof agent !== 'object' || agent === null) return undefined
  const session = (agent                           ).session
  if (typeof session !== 'object' || session === null) return undefined
  const id = (session                           ).id
  if (typeof id !== 'string' && typeof id !== 'number') return undefined

  const frame = record.frame
  if (typeof frame !== 'object' || frame === null) return undefined
  const f = frame                           
  if (f.type !== 'chunk') return undefined
  const chunk = f.chunk
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const c = chunk                           
  // The two delta kinds are the model's own speech: `reasoning-delta` while it
  // thinks, `text-delta` for the answer it writes. Everything else (tool-call
  // deltas, a frame's start and end) says nothing this line reports.
  const kind = c.type === 'reasoning-delta' ? 'reasoning' : c.type === 'text-delta' ? 'text' : undefined
  if (kind === undefined) return undefined
  if (typeof c.text !== 'string' || c.text === '') return undefined
  return { key: String(id), text: c.text, kind }
}

function printProgress(sessions                              , displaySession                    )       {
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
