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
  foldProgressEvent,
  renderBubble,
  PROGRESS_TTL_MS,
                    
                      
} from './progress.js'

/** The announcement slot key. One slot per publisher, so this coexists with
 * the quota / balance bubbles other plugins push. */
export const PROGRESS_SOURCE = 'pet-progress'

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
                       
                     
 

/** Per-session progress, plus the last bubble actually published. */
                           
                     
                                                                               
                         
                                                      
            
 

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
                   
                                   
                                               
 

/** Mount the companion against a resolved pet service. */
function mountWith(ctx         , pet         , config                )       {
  if (config.enabled === false) return

  const heartbeatMs = typeof config.heartbeatMs === 'number' && Number.isFinite(config.heartbeatMs) && config.heartbeatMs > 0
    ? config.heartbeatMs
    : PROGRESS_HEARTBEAT_MS

  const sessions = new Map                         ()
  /** The session whose progress owns the single announcement slot. */
  let displaySession                    

  /** Publish one bubble into this plugin's announcement slot. */
  const publish = (bubble                            )       => {
    if (bubble === undefined) return
    pet.announce({
      source: PROGRESS_SOURCE,
      kind: 'plan',
      title: bubble.title,
      percent: bubble.percent,
      tone: bubble.tone,
      note: bubble.note,
      ttlMs: Math.max(PROGRESS_TTL_MS, heartbeatMs * 3),
    })
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
    if (event.type !== 'todo/write' && event.type !== 'goal/change' && event.type !== 'turn/end' && event.type !== 'turn/start') return
    const key = String(session.id)
    const entry = sessions.get(key) ?? { at: 0 }

    // A new turn resumes whatever work the last one retired the bubble for. The
    // view is still here, so the bubble comes back without waiting for a
    // `todo/write` that may never arrive (the list only re-emits when it
    // changes). Nothing is resurrected when there is no view to show.
    if (event.type === 'turn/start') {
      if (entry.view === undefined || entry.bubble === undefined) return
      displaySession = key
      publish(entry.bubble)
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
      // The VIEW is kept, though, and that distinction is the whole point. A
      // `todo/write` is only emitted when the todo list CHANGES, so a new turn
      // that leaves the list alone re-emits nothing. Deleting the whole entry
      // here would therefore mute the plugin for the rest of the session: the
      // next turn starts, no todo event ever arrives, and no bubble ever comes
      // back. Retiring the bubble without forgetting the work lets the next
      // `turn/start` re-publish from the view we already hold.
      if (entry.view === undefined) {
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
    sessions.set(key, { view, ...(bubble === undefined ? {} : { bubble }), at: Date.now() })
    trim()

    // The most recent progress event owns the single announcement slot: the
    // user is looking at the session that is moving, and the pet bubble stack
    // is a finite column. It is not cleared by an unrelated session going
    // quiet, only by a progress-bearing event from another session.
    displaySession = key
    if (bubble !== undefined) publish(bubble)
  }))

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
 * Print the full progress of the displayed session. The bubble can only carry
 * one line, so the panel button is the place the detail lives; it goes to the
 * host log, which is where a user debugging a long run is already looking.
 */
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
}
