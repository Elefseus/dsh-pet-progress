# dsh-pet-progress

**A progress bar for your desktop pet.**

The [dsh web pet](https://github.com/zhu1090093659/dsh-pet) shows what the agent
is doing *right now* — thinking, calling a tool, done. It has no way to show how
much of a long task is finished, so a task that is 90% done looks exactly like
one that just started.

This plugin fixes that. It reads the todo lists and goals your agent already
writes to the session, and folds them into a percentage bubble on the pet.
A session that never writes a todo list isn't left blank either — there the
bubble falls back to a plain line saying what is happening right now.

![The pet showing 3/7 · 43% with the current task named](docs/images/hero.png)

## Install

One command, using the plugin's full GitHub URL:

```bash
dsh plugin add https://github.com/Elefseus/dsh-pet-progress
```

This requires the [dsh web pet](https://github.com/zhu1090093659/dsh-pet) to be
installed. If it is missing, the plugin stays loaded but publishes nothing —
you'll see a note in the dsh log rather than a crash.

**Restart DSH afterwards** — bundles are read only at startup, so the plugin
won't mount until you do. The bubble then appears on its own the next time your
agent writes a todo list or starts a goal; there is nothing to switch on.

For a named profile, use `dsh plugin --profile <name> add …`.

## What you'll see

A small bubble above the pet, refreshed about once a second:

| Situation | Bubble |
| --- | --- |
| Todo list, one task in progress | `3/7 · 43%` titled with that task |
| Todo list, several tasks in progress | `3/7 · 43%`, naming none |
| Long-lived goal with no todos | `2/8 轮` — the goal's round budget |
| Goal blocked | The block reason, in place of progress |
| No todo list and no goal | A plain line with no percentage — `等待模型响应`, `正在调用工具`, or the model's own words, led by `当前过程` or `最近输出` |

The bubble fades out about 30 seconds after the last progress update, so a
finished turn doesn't leave a stale percentage on screen. It comes back by itself
if the work resumes.

Several sessions can be open at once — the most recently active one owns the
bubble.

## Checking the full list

The bubble is one line, so there's a button for the rest: click **进度** on the
pet panel and the complete todo list is written to the dsh log.

## Good to know

- **It never over-reports.** A todo whose status the plugin doesn't recognise
  counts as *not done*. If every entry in a write is unreadable, the plugin
  treats it as "no information" and keeps what it had.
- **It won't guess.** If several tasks are in progress at once, the bubble shows
  the count and names none — naming the wrong task would be worse than naming
  nothing.
- **It reads, it doesn't judge.** A percentage comes from the todo lists and
  goals your agent writes; the plugin never infers progress from how long
  something has been running. Without either, it shows the plain activity line
  instead of a number.

## Requirements

| | |
| --- | --- |
| DSH | `>=0.1.7-rc.1` |
| `@linxin666/dsh-pet` | `>=0.4.0` (peer) |
| Node | `^22.19.0 \|\| >=24.0.0` |

The plugin binds to the pet's plugin-seam contract (`announce`,
`registerPanelAction`, and the `session/event` channel); an older pet does not
expose all three.

## Configuration

```ts
apply(ctx, { enabled?: boolean, heartbeatMs?: number })
```

With `enabled: false` nothing mounts. `heartbeatMs` defaults to `10000`.

## Using it from code

The plugin is host-only (no client bundle). The pet service is available as
`ctx.pet`, and the same three seams the pet publishes are what this plugin uses:

| Seam | Used for |
| --- | --- |
| `ctx.on('session/event', …)` | Reading `todo/write`, `goal/change`, and the turn/step/tool/message events behind the activity line |
| `ctx.pet.announce(…)` | Publishing the progress bubble |
| `ctx.pet.registerPanelAction(…)` | The `进度` panel button |

Adjust `PROGRESS_TTL_MS` and `MAX_TRACKED_SESSIONS` in
[`src/progress.ts`](src/progress.ts) to change the fade-out and how many sessions
are tracked at once.

## Development

`src/*.ts` is the source of truth; `lib/` is committed build output, because the
cordis loader does no transpilation. **After editing `src/`, rebuild and commit
`lib/` with it — CI fails if the two drift apart.**

```bash
node build.mjs              # rebuild lib/ from src/
node --test src/*.test.ts   # 52 tests, node:test only
```

To work on the code, skip installing and point the profile at your checkout:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-pet-progress": "file:<absolute path to this directory>" },
  "dsh": { "profile": { "bundles": ["…existing…", "dsh-pet-progress"] } }
}
```

A `bundles` entry alone is not enough — the package must also be a dependency.
If the path contains non-ASCII characters, write it as a `file://` URL. Restart
the app afterwards.

Node is pinned in `package.json` `engines` and exercised in CI at `22.19.0` and
`24.x`.

```bash
dsh plugin --profile desktop up dsh-pet-progress          # update to latest default branch
dsh plugin --profile desktop add "<repo>#<tag>"           # pin a tag instead (reproducible)
```

## More

- [Design notes](docs/DESIGN.md) — why the plugin is built this way: the event
  gap it fills, why it's a sibling rather than a patch, what it reports, and the
  two non-obvious details (deferred mounting, and an announcement slot with no
  retract).
- [中文说明](README.zh.md)

MIT
