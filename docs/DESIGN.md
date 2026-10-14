# Design notes

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
future `dsh plugin add` would overwrite. Instead this plugin uses the three
extension points the pet already publishes:

| Seam | Used for |
| --- | --- |
| `ctx.on('session/event', …)` | Reading `todo/write` + `goal/change`, retiring on `turn/end`, replaying on `turn/start`; the same channel also carries the turn/step/tool/message events behind the activity line — the pet listens on it too, so both observe every durable event |
| `ctx.pet.announce(…)` | Publishing the progress bubble into the pet's existing announcement stack |
| `ctx.pet.registerPanelAction(…)` | A `进度` button that prints the full todo list, since the bubble is one line |

The bubble is published with `kind: 'plan'`, which reuses the pet's existing
percent-bar rendering. No client bundle is needed — this plugin is host-only.

Both contracts are process-local and bounded by the pet itself, so a bug in this
plugin degrades to a silent bubble rather than pet breakage. Nothing here writes
to the session log or the pet's persisted state.

## What it reports

Priority order, highest first:

1. **A blocked goal outranks everything** and shows the human-readable reason —
   a blocked task is the one thing worth interrupting for.
2. **A todo list** shows a percentage bar plus `completed/total`, titled with
   the task currently `in_progress`.
3. **A goal with no todos** falls back to its round budget, e.g. `2/8 轮`.
4. **With neither a todo list nor a goal**, a plain activity line — no
   percentage. See the next section.

Two deliberate rules about trustworthiness:

- **Progress is never over-reported.** An unrecognised todo status counts as
  `pending`, not `completed` (`readTodo` in `src/progress.ts` treats anything
  that is not `completed` or `in_progress` as `pending`), and a list whose
  entries are all malformed is treated as *no information* rather than as
  *nothing to do*. An empty write does not blank an existing bubble.
- **A task is named only when the naming is unambiguous.** If several todos are
  `in_progress` at once, the bubble shows the count and names none, because a
  progress report that names the wrong task is worse than one that names none.

The bubble expires after 30 s (`PROGRESS_TTL_MS`) and is refreshed on a
heartbeat, so it survives quiet stretches instead of vanishing the moment the
model stops emitting events.

## When there is nothing to measure

A percentage needs something to measure, and plenty of sessions never write a todo
list — a plain question-and-answer turn has nothing to count. Those sessions used
to show nothing at all, leaving the pet's own phase word as the only signal.

The fallback is a **plain activity line**: the pet's phase vocabulary
(`正在调用工具`, `等待模型响应`, …) or, better, the model's most recent words. It
carries **no `percent`** and does not pretend to be a measurement — the same
announcement slot shows a title and note with the meter absent.

Four rules keep that line honest and stable:

- **It applies only to sessions with nothing to measure.** While a todo list or
  goal exists, activity events are not even folded, so a busy measured turn pays
  nothing for the fallback. The line appears only once both are gone.
- **Silence beats boilerplate.** `thinking` and `review` are suppressed unless
  the model itself said something (`QUIET_PHASES` in `src/index.ts`), so the
  bubble does not flicker between the model's words and `正在思考` between tool
  calls. A phase that names something concrete — `waiting`, `tool` — always
  publishes.
- **A nameless tool call says nothing.** `readActivity` returns `undefined` for a
  `tool/call` with no usable `name`, because the previous line already said more
  than the generic replacement would. A named call shows `正在调用 <name>`.
- **The line is summary-only state.** It claims no slot worth replaying, so
  `turn/end` *deletes* the session entry instead of parking it, and the next
  `turn/start` starts clean. The parked-view rule below covers todo-bearing
  sessions only.

The note under the title names the source: `当前过程` for a phase line,
`最近输出` for the model's own words.

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
kept, and the next `turn/start` re-publishes from it.

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
