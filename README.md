# dsh-pet-progress

Makes the [dsh web pet](https://github.com/zhu1090093659/dsh-pet) report **how much of the work is left**, not just what the model is doing right now.

[中文说明](./README.zh.md)

## The gap this fills

The pet already has a rich vocabulary for *transient activity*:

```
'idle' | 'waiting' | 'thinking' | 'tool' | 'review' | 'done' | 'failed'
```

All seven describe the current moment. None of them can express *"3 of 7 tasks done"*, so a long task looks identical whether it has just started or is nearly finished — and when the agent goes quiet between steps, the pet falls back to `idle` even though plenty of work remains.

Durable progress does exist in the session log. DSH records it as `todo/write` and `goal/change` events, but the pet's event projection switches only on `turn/start`, `step/start`, `assistant/message`, `tool/call`, `tool/result`, and `turn/end` — everything else returns `undefined` and is dropped:

```ts
// pet's event-projection.ts, verbatim behaviour
default:
  return undefined
```

So the information is already being written to the session; nothing was reading it.

## How it works

This is a **separate sibling plugin**, not a patch. The pet's own source is never modified, because it is an npm dependency that a future `dsh plugin add` would overwrite. Instead this plugin uses the three extension points the pet already publishes:

| Seam | Used for |
| --- | --- |
| `ctx.on('session/event', …)` | Reading `todo/write` + `goal/change`, retiring on `turn/end`, replaying on `turn/start` — the same channel the pet listens on, so both observe every durable event |
| `ctx.pet.announce(…)` | Publishing the progress bubble into the pet's existing announcement stack |
| `ctx.pet.registerPanelAction(…)` | A `进度` button that prints the full todo list, since the bubble is one line |

The bubble is published with `kind: 'plan'`, which reuses the pet's existing percent-bar rendering. No client bundle is needed — this plugin is host-only.

## What it reports

Priority order, highest first:

1. **A blocked goal outranks everything** and shows the human-readable reason — a blocked task is the one thing worth interrupting for.
2. **A todo list** shows a percentage bar plus `completed/total`, titled with the task currently `in_progress`.
3. **A goal with no todos** falls back to its round budget, e.g. `2/8 轮`.

Two deliberate rules about trustworthiness:

- **Progress is never over-reported.** An unrecognised todo status counts as `pending`, not `completed`, and a list whose entries are all malformed is treated as *no information* rather than as *nothing to do*. An empty write does not blank an existing bubble.
- **A task is named only when the naming is unambiguous.** If several todos are `in_progress` at once, the bubble shows the count and names none, because a progress report that names the wrong task is worse than one that names none.

The bubble expires after 30 s and is refreshed on a heartbeat, so it survives quiet stretches instead of vanishing the moment the model stops emitting events.

Standing is not the same as permanent, though: **`turn/end` retires the bubble, and `turn/start` brings it back.** A percentage for work nobody is doing any more is worse than no percentage at all, so when a turn ends the plugin drops the bubble and stops refreshing it, letting it expire. This matters because the pet's announcement contract has no retract — `announce()` only sets a slot and only the TTL expires it — so retiring a bubble means *not* re-publishing it. Refreshing even once more would restart the TTL and strand a finished turn's percentage on screen.

Retirement stops at the bubble, deliberately. `todo/write` is emitted only when the todo list **changes**, so a new turn that leaves the list alone emits nothing at all; if retiring also discarded the folded view, the plugin would go permanently mute for that session after its first turn end. The view is therefore kept, and the next `turn/start` re-publishes from it.

## Requirements

| | |
| --- | --- |
| DSH | `>=0.1.7-rc.1` |
| `@linxin666/dsh-pet` | `>=0.4.0` (peer) |
| Node | `^22.19.0 \|\| >=24.0.0` |

The pet's plugin-seam contracts (`announce`, `registerPanelAction`, and the `session/event` channel) are what this plugin binds to, so an older pet will not provide all three.

## Install

```bash
node build.mjs          # emits lib/*.js from src/*.ts
```

The cordis plugin loader performs **no transpilation**, so `main` must point at plain JavaScript. Rather than add a toolchain, `build.mjs` uses Node's own TypeScript transformer — the same one behind `node file.ts` — and additionally rewrites relative import specifiers, which the transformer does not do.

`lib/` is committed, so a checkout is loadable without building. Rebuild only after editing `src/`.

Then declare it in the profile and restart DSH:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-pet-progress": "file:<absolute path to this directory>" },
  "dsh": { "profile": { "bundles": ["…existing…", "dsh-pet-progress"] } }
}
```

`bundles` alone is not enough — the package must also be a dependency, and because the profile's package manager resolves `file:` specs, a path containing non-ASCII characters should be written as a `file://` URL. Restart the app afterwards: bundles are read at boot.

Installing from a git checkout:

```bash
dsh plugin add "file:<path to this directory>"
```

## Tests

```bash
node --test src/*.test.ts
```

48 tests, no test framework beyond `node:test`:

- `src/progress.test.ts` — the projection core: counting, percentage bounds, active-task ambiguity, refusal of malformed input, goal round budgets, `turn/end` retirement, and that every emitted title/note fits the announce contract's bounds.
- `src/wire.test.ts` — the bubble payload against the pet's actual `parseAnnouncement` limits, so a bubble this plugin emits cannot be silently dropped by the pet.
- `src/index.test.ts` — the host half: that it subscribes to the right events, ignores the rest, never throws on a malformed payload, composes goal + todo state across separate events, stops refreshing a retired bubble, brings it back on the next turn, mounts when the pet service is not yet available, and honours its off switch.

## Configuration

```ts
apply(ctx, { enabled?: boolean, heartbeatMs?: number })
```

`enabled: false` mounts nothing. `heartbeatMs` defaults to `10000`.

## Layout

```
src/progress.ts   pure projection: events → ProgressView → bubble copy (no cordis import)
src/index.ts      host adapter: subscriptions, session table, announce + panel action
build.mjs         type-stripping build
cordis.patch.yml  inserts the host row
```

## Notes on two non-obvious details

**Mounting is deferred, not immediate.** The pet publishes its service from inside its own fiber, so a sibling row can be applied *before* `ctx.pet` exists. Reading `ctx.pet` once and returning would mount the plugin and then silently disable it for the entire boot, with no error anywhere. `apply()` therefore waits via `ctx.inject(['pet'], …)` when the service is not up yet.

**The announcement slot has no retract.** `announce()` only *sets* a slot; only the TTL expires one. That is why retiring a bubble is implemented as "stop refreshing it" rather than "clear it", and why the plugin must never re-publish after a turn ends.

## License

[MIT](./LICENSE)
