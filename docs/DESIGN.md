# Design notes

**English** · [中文说明](DESIGN.zh.md)

Why `dsh-pet-progress` is built the way it is. The [README](../README.md) is for
using the plugin; this file is for changing it.

## The gap it fills

The pet already has a rich vocabulary for *transient activity*:

```
'idle' | 'waiting' | 'thinking' | 'tool' | 'review' | 'done' | 'failed'
```

All seven describe the current moment. None of them can express *"3 of 7 tasks
done"*, so a long task looks identical whether it has just started or is nearly
finished — and when the agent goes quiet between steps, the pet falls back to
`idle` even though plenty of work remains.

Durable progress does exist in the session log. DSH records it as `todo/write`
and `goal/change` events, but the pet's event projection switches only on
`turn/start`, `step/start`, `assistant/message`, `tool/call`, `tool/result`, and
`turn/end` — everything else returns `undefined` and is dropped:

```ts
// pet's event-projection.ts, verbatim behaviour
default:
  return undefined
```

So the information was already being written to the session; nothing was reading
it.

## Why a sibling plugin, not a patch

The pet's own source is never modified, because it is an npm dependency that a
future `dsh plugin add` would overwrite. Instead this plugin uses the extension
points the pet already publishes:

| Seam | Used for |
| --- | --- |
| `ctx.on('session/event', …)` | Reading `todo/write` + `goal/change`, retiring on `turn/end`, replaying on `turn/start`; the same channel also carries the turn/step/tool/message events behind the activity line — the pet listens on it too, so both observe every durable event |
| `ctx.on('agent/assistant-stream', …)` | The live model output for the activity line, read from `text-delta` chunks. A process-local publication rather than a session event, so the session is taken from `agent.session.id` |
| `ctx.pet.announce(…)` | Publishing the progress bubble into the pet's existing announcement stack |
| `ctx.pet.registerPanelAction(…)` | A `进度` button that prints the full todo list, since the bubble is one line |

A measured bubble is published with `kind: 'plan'`, which reuses the pet's
existing percent-bar rendering; the numberless summary rides `cost` instead (see
[When there is nothing to measure](#when-there-is-nothing-to-measure)). No client
bundle is needed — this plugin is host-only.

Both contracts are process-local and bounded by the pet itself, so a bug in this
plugin degrades to a silent bubble rather than pet breakage. Nothing here writes
to the session log or the pet's persisted state.

## What it reports

Priority order, highest first:

1. **A blocked goal outranks everything** and shows the human-readable reason —
   a blocked task is the one thing worth interrupting for.
2. **A todo list** shows a percentage bar plus `completed/total`, titled with
   the task currently `in_progress` — or, when several are running, naming them
   all (up to three, then `+N`), because "which of these is the work" is exactly
   the question a multi-task list raises.
3. **A goal with no todos** falls back to its round budget, e.g. `2/8 轮`.
4. **With neither a todo list nor a goal**, a plain activity line — no
   percentage. See the next section.

Two deliberate rules about trustworthiness:

- **Progress is never over-reported.** An unrecognised todo status counts as
  `pending`, not `completed` (`readTodo` in `src/progress.ts` treats anything
  that is not `completed` or `in_progress` as `pending`), and a list whose
  entries are all malformed is treated as *no information* rather than as
  *nothing to do*. An empty write does not blank an existing bubble.
- **A task is named only when the naming is unambiguous.** Several running tasks
  are named individually rather than resolved to one, so the bubble never picks
  a task and presents it as *the* task. Beyond three names it stops naming and
  counts (`+2`), because a title that has to scroll is not a status line.

The bubble expires after 30 s (`PROGRESS_TTL_MS`) and is refreshed on a
heartbeat, so it survives quiet stretches instead of vanishing the moment the
model stops emitting events.

## When there is nothing to measure

A percentage needs something to measure, and plenty of sessions never write a todo
list — a plain question-and-answer turn has nothing to count. Those sessions used
to show nothing at all, leaving the pet's own phase word as the only signal.

The fallback is a **plain activity line**, and it draws on three sources in
order: the model's own speech *as it is streamed* (`agent/assistant-stream`,
`reasoning-delta` and `text-delta` chunks), the purpose of the tool it just
called (`正在调用 pwsh：npm test`), and only then the pet's bare phase word
(`等待模型响应`, …). It carries **no `percent`** and does not pretend to be a
measurement.

The live stream is read rather than the durable `assistant/message` because the
durable event lands only when the attempt finishes — a fallback fed by it alone
says nothing for exactly the stretch of time the user is watching. The
publication is decoded structurally (`readLiveDelta` in `src/index.ts`) against
the fields the plugin needs (`agent.session.id`, `frame.chunk.text`), never by
importing the agent's frame types, so a change on that side degrades to "no live
line" instead of a throwing listener.

Both halves of the model's own speech are shown: `reasoning-delta` while it is
thinking, `text-delta` once it starts writing the answer. They are different
sentences, so the buffer — and the throttle window — resets when the kind flips
instead of splicing a thought onto the answer that followed it, and each carries
its own lead (`正在思考` / `最近输出`). A bare phase line is the last resort, for
the stalls where neither has said anything yet.

That line needs the one shape the announcement contract does *not* have. The pet
validates every payload: `plan` requires a `percent`, `balance` and `cost`
require an `amount`, and `parseAnnouncement` returns `undefined` for anything
else — which the pet then drops **in silence**, so the failure looks exactly like
a progress bubble that was never sent. The summary therefore rides `cost`, the
shape whose `amount` the client renders verbatim as the bubble's body, and the
lead (`title`) names the source instead: that is the only text a numberless
bubble is guaranteed to have. `announcePayload` in `src/progress.ts` derives the
kind from the bubble in one place, so the host adapter and `src/wire.test.ts`
cannot disagree about it — the wire suite builds its payloads through the same
function and checks them against the pet's real validator.

Four rules keep that line honest and stable:

- **It applies only to sessions with nothing to measure.** While a todo list or
  goal exists, activity events are not even folded, so a busy measured turn pays
  nothing for the fallback. The line appears only once both are gone.
- **Silence beats boilerplate.** The bare phase line publishes only when it names
  something concrete (`waiting`, `tool`); `thinking` and `review` are suppressed
  (`QUIET_PHASES` in `src/index.ts`) so the bubble does not flicker back to
  `正在思考` between two deltas of the same sentence. The model's own words always
  publish.
- **A tool call says what it is for.** `toolHint` in `src/progress.ts` reads the
  most specific argument the session stored — `command`, then `query`, `path`,
  `file_path` (shown by base name), `url`, `name` — and `readActivity` appends it,
  giving `正在调用 read：progress.ts` instead of `正在调用工具`. The arguments
  arrive as JSON *text*, so they are parsed structurally; a bad payload degrades
  to the bare tool name, and a call with no usable name returns `undefined`
  because the previous line already said more than the generic replacement.
- **The line is summary-only state.** It claims no slot worth replaying, so
  `turn/end` *deletes* the session entry instead of parking it, and the next
  `turn/start` starts clean — including the live-text buffer, so a new turn never
  opens with the previous turn's words. The parked-view rule below covers
  todo-bearing sessions only.

Repaints are throttled: deltas arrive far faster than a bubble can be read, so
`src/index.ts` repaints at most once per `STREAM_PUBLISH_MS` (400 ms) while
buffering up to `STREAM_BUFFER_MAX` (600) characters, and only the newest
`ACTIVITY_TEXT_MAX` characters of that buffer are shown — the tail is the part
that says what is happening *now*.


The lead names the source: `当前过程` for a phase line, `正在思考` for the model's
reasoning, `最近输出` for the words it is writing. The body is the line itself.

## Standing is not permanent

**`turn/end` retires the bubble, and `turn/start` brings it back.** A percentage
for work nobody is doing any more is worse than no percentage at all, so when a
turn ends the plugin drops the bubble and stops refreshing it, letting it expire.

This matters because the pet's announcement contract has no retract —
`announce()` only sets a slot and only the TTL expires it — so retiring a bubble
means *not* re-publishing it. Refreshing even once more would restart the TTL and
strand a finished turn's percentage on screen.

Retirement stops at the bubble, deliberately. `todo/write` is emitted only when
the todo list **changes**, so a new turn that leaves the list alone emits nothing
at all; if retiring also discarded the folded view, the plugin would go
permanently mute for that session after its first turn end. The view is therefore
kept — unless it has nothing live left in it, see below — and the next
`turn/start` re-publishes from it.

### A finished list is a moment, not a standing bubble

"Pinned at `任务全部完成` forever" is the failure this rule exists to prevent. The
re-publish-on-`turn/start` rule above is right for work that is still going and
wrong for work that is over: a list with `completed === total` is a finished
thing, and replaying it on every later turn makes a *completed* state look like
a *current* one — on screen, permanently.

So the renderer distinguishes two bubble lifetimes:

- a **standing** bubble (a percentage with work left, a goal still moving, a
  live activity line) is refreshed on the heartbeat and lives until the turn
  ends;
- a **moment** (`任务全部完成`, `目标完成`) is announced **once** with
  `PROGRESS_MOMENT_TTL_MS` (10 s) and is never stored as the session's standing
  bubble, so neither the heartbeat nor the next `turn/start` can renew it.

For those ten seconds the moment keeps the slot: `momentAt` in the session entry
makes `adoptSummary` refuse an activity line, because the agent normally keeps
talking immediately after finishing a list and the next streamed token would
otherwise replace the line within one throttle window — the one bubble the user
asked for would be the one they never see. A new `todo/write` or `goal/change`
with live progress is a measurement, not a summary, so it still takes over the
moment the work actually resumes.

`hasLiveProgress` in `src/progress.ts` is the single predicate behind the
distinction: it is false for a finished list and a completed goal, and true for
a blocked goal (waiting on a human is not finished). `src/index.ts` uses it in
three places — the `turn/start` replay guard, the activity fallback's gate, and
the `turn/end` retirement — so all three agree about what "still has work" means.

Making the moment path unreachable for a *measurement* is what lets the activity
fallback take over afterwards: once a list is finished, the session has nothing
left to measure, and the next event re-enters the summary path instead of
replaying a 100% bar.

## Two non-obvious details

**Mounting is deferred, not immediate.** The pet publishes its service from
inside its own fiber, so a sibling row can be applied *before* `ctx.pet` exists.
Reading `ctx.pet` once and returning would mount the plugin and then silently
disable it for the entire boot, with no error anywhere. `apply()` therefore waits
via `ctx.inject(['pet'], …)` when the service is not up yet.

**The announcement slot has no retract.** `announce()` only *sets* a slot; only
the TTL expires one. That is why retiring a bubble is implemented as "stop
refreshing it" rather than "clear it", and why the plugin must never re-publish
after a turn ends.

## State and bounds

There is no state object in the projection: every event is a **complete
snapshot** (`todo/write` carries the full list, `goal/change` carries the whole
goal), so the fold is a pure function of `(previous view, event)` and the caller
only has to hold the last view. That keeps the whole feature testable without a
cordis host.

At most `MAX_TRACKED_SESSIONS` (24) sessions keep independent progress state,
dropping the least recently touched. The most recent progress-bearing event owns
the single announcement slot: the user is looking at the session that is moving,
and the pet bubble stack is a finite column. It is not cleared by an unrelated
session going quiet, only by a progress-bearing event from another session.

## Build

The cordis plugin loader performs **no transpilation**, so `main` must point at
plain JavaScript. Rather than add a toolchain, `build.mjs` uses Node's own
TypeScript transformer — the same one behind `node file.ts` — and additionally
rewrites relative import specifiers, which the transformer does not do.

`lib/` is committed, so a checkout is loadable without building. CI fails if
`src/` and `lib/` drift apart.
