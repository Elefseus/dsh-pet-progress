/**
 * Progress projection — pure, clock-injected. Folds the durable DSH progress
 * vocabulary (`todo/write`, `goal/change`) into one compact view of "how much
 * of this work is done", which the pet's status bubble then renders.
 *
 * Why this module exists at all: the pet's own projection
 * (`@linxin666/dsh-pet/event-projection`) maps session events onto TRANSIENT
 * phases — thinking / tool / review — so the companion can say what the model
 * is doing at this instant, but never how far along the work is. The durable
 * log has carried the missing half all along (`todo/write` and `goal/change`
 * are declared in `KNOWN_SESSION_EVENT_TYPES` of @deepseek-ai/dsh-session);
 * the pet simply drops them. This module reads that half and turns it into a
 * bubble payload.
 *
 * There is no state object here: every event is a COMPLETE snapshot
 * (`todo/write` carries the full list, `goal/change` carries the whole goal),
 * so the fold is a pure function of (previous view, event) and the caller only
 * has to hold the last view. That keeps the whole feature testable without a
 * cordis host.
 * @module dsh-pet-progress/progress
 */

/**
 * Todo statuses, as declared by `TodoItem` in the session vocabulary. Anything
 * else is an unknown future status and is treated as not-done (fail-closed:
 * the bubble must never over-report completed work).
 */
                                                                

/** One todo item as the session log carries it. */
                           
                 
                    
 

/** Goal phases, as declared by `GoalPhase` in @deepseek-ai/dsh-goal. */
                                                                    

/**
 * The transient activity phases the pet already names, in the subset this
 * projection uses. Mirrors `PetStateInput['phase']` in
 * `@linxin666/dsh-pet/event-projection`.
 */
                                                                                                   

/**
 * The fallback story, for work that has no todo list and no goal: what the
 * session is doing right now.
 *
 * This is the plugin's answer to "the agent is mid-task but never wrote a todo
 * list". The pet already renders that as its own status bubble, but the status
 * bubble is a MOMENT — it is not durable, it does not survive the session being
 * de-emphasised by the multi-session stack, and it carries no text the user can
 * pin. The announcement slot is the durable surface, so the same information is
 * mirrored into it.
 */
                                  
                                                                               
              
                                                                                  
                          
     
                                   
    
                                                                             
                                                                            
                                                                                
                                                                       
     
                      
 

/**
 * How many characters of the tail of the model's own text are kept. A whole
 * assistant message can be thousands of characters and the bubble is one line,
 * so the TAIL is what gets shown: the end of a message is where the model states
 * what it is about to do or has just concluded, and it is the half a reader of a
 * progress bubble is missing.
 */
export const ACTIVITY_TEXT_MAX = 120

/** How many in-progress todo names the view keeps for the bubble to show. */
export const ACTIVE_TODO_MAX = 3

/** How many characters of each in-progress todo name are kept. */
export const ACTIVE_TODO_CHARS = 32

/** The goal facts this projection keeps. */
                               
                   
                  
                                                  
                       
                                                                           
                       
                                             
                        
 

/** The folded progress view: what the bubble needs, nothing more. */
                               
                                                
               
                   
                 
                    
     
                                                                           
                             
    
                                                                               
                                                                               
                                                                           
                                                   
     
                        
                                                 
                     
     
                                                                           
                                                                            
                                   
     
                            
                                                                                    
                 
 

/** Visual tone, aligned with the pet announcement contract's `tone`. */
                                                

/**
 * What the bubble should say, in the shape `ctx.pet.announce` accepts. Kept
 * separate from `ProgressView` so the copy rules are testable on their own and
 * the host adapter has nothing to decide.
 *
 * The two things this plugin reports are not the same SHAPE of fact, and the
 * announcement contract has no numberless kind to render the second one:
 * `plan` requires a `percent`, `balance` and `cost` require an `amount`, and
 * `parseAnnouncement` returns undefined for anything else — a malformed
 * announcement is then dropped in silence. So the shape is carried here and the
 * host adapter derives the wire `kind` from it:
 *
 * - a todo list and a goal are MEASUREMENTS: they have a percentage, so they
 *   fill `percent` and ride `plan`, which the pet renders with a meter;
 * - "the agent is reading a file" is a STATE, not a measurement: there is no
 *   honest number to put on it, so it fills `amount` and rides `cost` rather
 *   than inventing a percentage. The client renders `amount` verbatim with no
 *   currency formatting, and the pet's own quota plugin publishes free text
 *   there too (e.g. `今日 1.2M tokens`).
 */
                                 
               
                                                  
                  
                                                                              
                 
               
                    
     
                                                                               
                                                                               
    
                                                                               
                                                                               
                                                                       
                                                                             
     
                  
 

/** Title bound, mirroring the pet announcement contract's TITLE_MAX. */
export const PROGRESS_TITLE_MAX = 80

/** Note bound, mirroring the pet announcement contract's TITLE_MAX. */
export const PROGRESS_NOTE_MAX = 80

/** Amount bound, mirroring the pet announcement contract's TEXT_MAX. */
export const PROGRESS_AMOUNT_MAX = 120

/**
 * How long a progress bubble stays fresh. Progress is a STANDING fact, not a
 * moment, so the host re-publishes it on every event and on a slow heartbeat;
 * the TTL only has to outlive the gap between those, so a dead plugin's bubble
 * still clears itself within one missed cycle.
 */
export const PROGRESS_TTL_MS = 30_000

/**
 * How long a MOMENT bubble stays fresh — a finished list, a completed goal.
 *
 * These are announced once and never refreshed, so this TTL is the bubble's
 * whole life. It matches the pet's own default announcement TTL: long enough to
 * be read, short enough that a stale "all done" is not left hanging over a
 * session the user has already moved on from.
 */
export const PROGRESS_MOMENT_TTL_MS = 10_000

/** The announcement slot key. One slot per publisher, so this coexists with
 * the quota / balance bubbles other plugins push. */
export const PROGRESS_SOURCE = 'pet-progress'

/** The announcement payload as it goes on the wire, in the shape
 * `ctx.pet.announce` accepts. */
                                  
                
                       
               
                  
                 
               
                    
               
 

/**
 * Build the wire payload for one bubble.
 *
 * The `kind` is DERIVED rather than declared, because the pet's announcement
 * contract has no numberless kind: `plan` requires a `percent`, `balance` and
 * `cost` require an `amount`, and `parseAnnouncement` returns undefined for
 * anything else — which the pet then drops in silence. A wrong shape therefore
 * shows up as a bubble that never renders, not as an error, which is exactly
 * how the summary fallback shipped broken once. A bubble with no measurement
 * rides `cost`, whose `amount` the client renders verbatim as the body.
 *
 * This lives here, next to the bounds it mirrors, so the host adapter and the
 * wire test build the payload the same way and cannot drift apart.
 * @param bubble - the rendered bubble.
 * @param ttlMs - freshness window; it has to outlive the re-publish gap.
 */
export function announcePayload(bubble                , ttlMs        )                  {
  const shared = {
    source: PROGRESS_SOURCE,
    title: bubble.title,
    ...(bubble.note === undefined ? {} : { note: bubble.note }),
    tone: bubble.tone,
    ttlMs,
  }
  if (bubble.percent === undefined) {
    // The title is the only text such a bubble is guaranteed to have, so it
    // backs up `amount` rather than letting an empty one be rejected.
    return { ...shared, kind: 'cost', amount: bubble.amount ?? bubble.title }
  }
  return { ...shared, kind: 'plan', percent: bubble.percent }
}

/** Elide on a word boundary when one is close enough to the limit to read
 * better, otherwise hard-cut — a bubble is single-line chrome, not prose. */
function elide(collapsed        , max        )         {
  const cut = collapsed.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  const body = lastSpace >= max * 0.6 ? cut.slice(0, lastSpace) : cut
  return body.trimEnd() + '…'
}

/** Compact a string for the bubble, collapsing whitespace and eliding. */
export function compactText(value         , max        )         {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return elide(collapsed, max)
}

/**
 * Compact a string keeping its END rather than its start.
 *
 * Model output is not a label: it is prose that arrives whole, and the useful
 * half for a progress bubble is the tail — the last thing the model said it was
 * doing. Eliding from the front ("…and now I'll fix the parser") keeps the part
 * that still says something, where a head-cut would show the setup and drop the
 * conclusion.
 */
export function compactTail(value         , max        )         {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  const rest = collapsed.slice(-(max - 1))
  // Cut on the first space so the kept text starts at a word boundary; falling
  // back to the raw slice when there is none (a single long token).
  const firstSpace = rest.indexOf(' ')
  const body = firstSpace >= 0 && firstSpace < rest.length - 1 ? rest.slice(firstSpace + 1) : rest
  return '…' + body.trimStart()
}

/** Read one `TodoItem`, refusing malformed entries rather than trusting them. */
function readTodo(value         )                       {
  if (typeof value !== 'object' || value === null) return undefined
  const data = value                           
  const content = compactText(data.content, 200)
  if (content === '') return undefined
  // An unrecognized status is not silently upgraded to 'completed': the whole
  // point of this bubble is to be trustworthy about what is left.
  const status             = data.status === 'completed' || data.status === 'in_progress'
    ? data.status
    : 'pending'
  return { content, status }
}

/**
 * Fold one `todo/write` payload into a view.
 *
 * `todo/write` is a full snapshot every time — the agent rewrites the list —
 * so the previous view is irrelevant here and the result stands alone.
 * @param todos - the raw `payload.todos` array from the session event.
 * @returns the view, or undefined when the payload carries no usable todos
 * (an empty or malformed write must not blank an existing bubble).
 */
export function foldTodos(todos         )                           {
  if (!Array.isArray(todos)) return undefined
  const items = todos.map(readTodo).filter((item)                   => item !== undefined)
  if (items.length === 0) return undefined
  const completed = items.filter(item => item.status === 'completed').length
  const inProgressItems = items.filter(item => item.status === 'in_progress')
  const pending = items.length - completed - inProgressItems.length
  return {
    total: items.length,
    completed,
    pending,
    inProgress: inProgressItems.length,
    // Every in-progress todo is named, not just a lone one: parallel work is
    // exactly when the user most needs to know WHICH tasks are running, and the
    // old single-name rule fell back to a generic label there.
    ...(inProgressItems.length === 0
      ? {}
      : {
          activeTodos: inProgressItems
            .slice(0, ACTIVE_TODO_MAX)
            .map(item => compactText(item.content, ACTIVE_TODO_CHARS)),
        }),
    percent: Math.round((completed / items.length) * 100),
  }
}

/** Read one goal snapshot out of a `goal/change` payload. */
function readGoal(value         )                           {
  if (typeof value !== 'object' || value === null) return undefined
  const data = value                           
  const objective = compactText(data.objective, 200)
  if (objective === '') return undefined
  const phase            = data.phase === 'paused' || data.phase === 'blocked' || data.phase === 'complete'
    ? data.phase
    : 'active'
  const maxGoalRounds = typeof data.maxGoalRounds === 'number' && Number.isFinite(data.maxGoalRounds)
    ? Math.max(0, Math.trunc(data.maxGoalRounds))
    : 0
  const roundsStarted = typeof data.roundsStarted === 'number' && Number.isFinite(data.roundsStarted)
    ? Math.max(0, Math.trunc(data.roundsStarted))
    : 0
  const rawReason = data.blockedReason
  const reason = typeof rawReason === 'object' && rawReason !== null
    ? compactText((rawReason                           ).message, 120)
    : ''
  return {
    objective,
    phase,
    maxGoalRounds,
    roundsStarted,
    ...(reason === '' ? {} : { blockedReason: reason }),
  }
}

/** Result of folding one session event. */
                          
                                        
                                                                         
                     
                                                                              
                      

/**
 * Fallback copy for the phases that carry no model text of their own. Short on
 * purpose: the note slot beside it says where the line came from, so the title
 * does not have to explain itself.
 */
const PHASE_LINE                                = {
  idle: '空闲',
  waiting: '等待模型响应',
  thinking: '正在思考',
  tool: '正在调用工具',
  review: '正在阅读输出',
  done: '本轮已完成',
  failed: '本轮出错',
  // Unreachable: ActivityPhase is exhaustive above. Kept so a future phase
  // added to the union fails the build here rather than rendering blank.
}

/**
 * Whether a raw phase string is one this plugin has copy for. Anything else is
 * a future phase and is ignored rather than guessed at.
 */
export function isActivityPhase(phase         )                         {
  return typeof phase === 'string' && Object.hasOwn(PHASE_LINE, phase)
}

/**
 * Fold one activity-bearing event into a summary.
 *
 * Two sources are accepted, in this order:
 *  - the model's own text (`assistant/message`), which names the actual work;
 *  - the pet's vocabulary phase (`turn/start`, `step/start`, `tool/call`,
 *    `assistant/message`, `tool/result`), which only names the kind of work.
 *
 * The text source ERRORS ON THE SAFE SIDE in two places. A message may carry
 * reasoning and text blocks interleaved, so the LAST text block wins rather than
 * the first — that is the model's most recent statement. And a message with no
 * usable text (a pure tool-call turn, which is the common case mid-task) yields
 * the phase line instead of a blank bubble.
 * @param payload - the event's `data`.
 * @returns the summary, or undefined when this payload says nothing about what
 * is happening.
 */
export function readActivity(payload         )                              {
  if (typeof payload !== 'object' || payload === null) return undefined
  const data = payload                           

  const text = lastTextBlock(data.message) ?? (typeof data.text === 'string' ? data.text : undefined)
  if (text !== undefined) {
    const line = compactTail(text, ACTIVITY_TEXT_MAX)
    // The model's own words borrow the phase they arrived with, so a consumer
    // still knows which moment of the turn produced them.
    if (line !== '') return { line, source: 'text', phase: isActivityPhase(data.phase) ? data.phase : 'thinking' }
  }

  // `tool/call` carries the tool's name inline; every other phase-bearing event
  // identifies itself by type, which the host passes in as `phase`. A tool call
  // with no name is NOT worth the generic phase line: the fallback exists to say
  // what is happening, and '正在调用工具' without saying which tool says less
  // than the previous line already did.
  const phase = data.phase
  if (phase === 'tool') {
    if (typeof data.name !== 'string' || data.name.trim() === '') return undefined
    return { line: `正在调用 ${compactText(data.name, 40)}`, source: 'phase', phase }
  }
  if (!isActivityPhase(phase)) return undefined
  return { line: PHASE_LINE[phase], source: 'phase', phase }
}

/**
 * The text of the LAST text block in an assistant message.
 *
 * The block shape is the session vocabulary's (`{ type: 'text', text }`), read
 * structurally and defensively: a malformed block is skipped rather than
 * throwing into the pet's event path.
 */
function lastTextBlock(message         )                     {
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message                           ).content
  if (!Array.isArray(content)) return undefined
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]
    if (typeof block !== 'object' || block === null) continue
    const data = block                           
    if (data.type !== 'text') continue
    if (typeof data.text === 'string' && data.text.trim() !== '') return data.text
  }
  return undefined
}

/**
 * Fold one session event into the next progress view.
 *
 * The two contributing event types are full snapshots, so this needs no
 * previous view to be correct — it is `(previous, event) -> next` only so a
 * `goal/change` can compose with a todo list observed earlier, and so a goal
 * snapshot that arrives after the todos does not erase the todo progress.
 *
 * `turn/end` is the third input, and it is a RETIREMENT rather than a
 * measurement. Progress measures work that is still moving; once a turn ends
 * nothing is moving, so the last snapshot is history, not status. Leaving it up
 * is actively misleading — a stopped session would otherwise sit at "75%"
 * forever, because the caller keeps the standing bubble alive on a heartbeat.
 * This mirrors the pet's own projection, which maps `turn/end` onto a terminal
 * phase and drops the session from its bubble stack.
 * @param previous - the view held for this session, when any.
 * @param type - the durable session event type.
 * @param payload - that event's `data`.
 * @returns the fold outcome.
 */
export function foldProgressEvent(
  previous                          ,
  type        ,
  payload         ,
)               {
  // A finished turn retires the bubble regardless of how much was left undone:
  // the remaining percentage describes work nobody is doing any more.
  if (type === 'turn/end') return { kind: 'clear' }

  if (type === 'todo/write') {
    if (typeof payload !== 'object' || payload === null) return { kind: 'ignore' }
    const view = foldTodos((payload                           ).todos)
    if (view === undefined) return { kind: 'ignore' }
    // A todo snapshot replaces the todo half of the view and keeps the goal
    // half: the two arrive independently and neither supersedes the other. The
    // activity summary is deliberately NOT kept — once a list exists it is a
    // measurement, and a stale line would make the completion moment render the
    // previous activity instead of saying the list finished.
    return {
      kind: 'view',
      view: {
        ...view,
        ...(previous?.goal === undefined ? {} : { goal: previous.goal }),
      },
    }
  }

  if (type !== 'goal/change') return { kind: 'ignore' }
  if (typeof payload !== 'object' || payload === null) return { kind: 'ignore' }
  const data = payload                           

  if (data.operation === 'clear') {
    // A cleared goal leaves any todo progress standing; only the goal half goes.
    if (previous === undefined) return { kind: 'clear' }
    const { goal: _goal, ...rest } = previous
    // A view with neither a todo list nor a goal has nothing left to report, so
    // the summary gives way rather than keeping the slot alive on its own.
    return rest.total === 0 ? { kind: 'clear' } : { kind: 'view', view: rest                 }
  }

  const goal = readGoal(data.goal)
  if (goal === undefined) return { kind: 'ignore' }
  // `roundsStarted` rides the CHANGE META, not the goal snapshot itself
  // (GoalSnapshotChangeMeta: { operation, goal, roundsStarted, createdAt }), so
  // it has to be read from the payload's own level.
  if (typeof data.roundsStarted === 'number' && Number.isFinite(data.roundsStarted)) {
    goal.roundsStarted = Math.max(0, Math.trunc(data.roundsStarted))
  }
  const next               = {
    ...(previous ?? { total: 0, completed: 0, pending: 0, inProgress: 0, percent: 0 }),
    goal,
  }
  if (previous === undefined) {
    // A goal with no todos still has a story to tell: the round budget is the
    // progress bar (`3/8 rounds`), which is the only progress a long-running
    // autonomous goal exposes.
    next.percent = goalPercent(goal)
  }
  return { kind: 'view', view: next }
}

/** Completion 0-100 for a goal that has no todo list to measure. */
export function goalPercent(goal              )         {
  if (goal.phase === 'complete') return 100
  if (goal.maxGoalRounds <= 0) return 0
  return Math.min(100, Math.round((goal.roundsStarted / goal.maxGoalRounds) * 100))
}

/**
 * Whether a view describes work that is still MOVING.
 *
 * This is the question the host asks in three places, and getting it wrong is
 * what made a finished todo list camp on the bubble: `turn/end` keeps a view
 * around so the next turn can replay it, but replaying history is only wanted
 * while there is still work in it. A list that is fully done and a goal that is
 * complete are finished facts, so they are reported once and not resumed.
 * @param view - the folded progress view.
 */
export function hasLiveProgress(view                          )          {
  if (view === undefined) return false
  if (view.goal !== undefined && view.goal.phase !== 'complete') return true
  return view.total > 0 && view.completed < view.total
}

/** The lead line for a todo bubble: the work actually in progress. */
function todoLead(view              )         {
  const names = view.activeTodos ?? []
  if (names.length === 0) return view.goal?.objective ?? '进行中的任务'
  const shown = names.slice(0, 2)
  // The view caps `activeTodos` at ACTIVE_TODO_MAX, so `+N` comes from the real
  // in-progress count rather than from how many names happened to be kept.
  const extra = view.inProgress - shown.length
  return shown.join('、') + (extra > 0 ? ` +${extra}` : '')
}

/**
 * Render the bubble copy for a view.
 *
 * The rules, in priority order:
 * - a blocked goal outranks everything: it needs the user, and it says why;
 * - a todo list with work left outranks the goal for the bar, because it is the
 *   finer measurement of the same work;
 * - a goal that is still moving becomes the bar after that;
 * - with neither, the activity summary stands in — as a state, not a measurement;
 * - and only when none of those apply is the completion itself reported, as a
 *   MOMENT that the host announces once and lets expire.
 * @param view - the folded progress view.
 * @returns the bubble, or undefined when there is nothing worth showing.
 */
export function renderBubble(view                          )                             {
  if (view === undefined) return undefined
  const { goal } = view
  const hasTodos = view.total > 0
  const allDone = hasTodos && view.completed === view.total

  if (goal?.phase === 'blocked') {
    const detail = goal.blockedReason ?? goal.objective
    return {
      title: compactText(detail, PROGRESS_TITLE_MAX),
      percent: hasTodos ? view.percent : goalPercent(goal),
      note: hasTodos ? todoNote(view) : '受阻',
      tone: 'low',
    }
  }

  // A list with work left is the finest measurement there is.
  if (hasTodos && !allDone) {
    return {
      title: compactText(todoLead(view), PROGRESS_TITLE_MAX),
      percent: view.percent,
      note: todoNote(view),
      tone: 'warn',
    }
  }

  // From here the todo half is absent or finished, so a goal still moving owns
  // the bubble rather than being masked by a finished list.
  if (goal !== undefined && goal.phase !== 'complete') {
    if (goal.phase === 'paused') {
      return { title: compactText(goal.objective, PROGRESS_TITLE_MAX), percent: goalPercent(goal), note: '已暂停', tone: 'low' }
    }
    return {
      title: compactText(goal.objective, PROGRESS_TITLE_MAX),
      percent: goalPercent(goal),
      note: goal.maxGoalRounds > 0 ? `${goal.roundsStarted}/${goal.maxGoalRounds} 轮` : '目标进行中',
      tone: 'warn',
    }
  }

  // Nothing is moving. A summary of what is happening right now beats a finished
  // list, and it is a STANDING state: the host keeps refreshing it until the
  // turn ends, so it does not blink out between tool calls.
  if (view.activity !== undefined) return activityBubble(view.activity)

  if (allDone) {
    return { title: '任务全部完成', percent: 100, note: todoNote(view), tone: 'ok', moment: true }
  }
  if (goal?.phase === 'complete') {
    return {
      title: compactText(goal.objective, PROGRESS_TITLE_MAX),
      percent: 100,
      note: '目标完成',
      tone: 'ok',
      moment: true,
    }
  }
  return undefined
}

/** The bubble for an activity summary: its source is the lead, the line the body. */
function activityBubble(activity                 )                 {
  return {
    title: activity.source === 'text' ? '最近输出' : '当前过程',
    amount: compactText(activity.line, PROGRESS_AMOUNT_MAX),
    tone: 'low',
  }
}

/** The trailing `3/8` counter for a todo view. */
function todoNote(view              )         {
  return compactText(`${view.completed}/${view.total}`, PROGRESS_NOTE_MAX)
}
