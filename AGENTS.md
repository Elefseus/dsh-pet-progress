# dsh-pet-progress

Progress companion for the [dsh web pet](https://github.com/zhu1090093659/dsh-pet): reads the durable `todo/write` and `goal/change` events the pet ignores, and folds them into a percentage bubble.

- [English README](./README.md)
- [中文说明](./README.zh.md)

```bash
node build.mjs              # rebuild lib/ from src/ (only needed after editing src/)
node --test src/*.test.ts    # 76 tests, no framework beyond node:test
```

## Building and testing

- `src/*.ts` is the source of truth; `lib/` is committed build output (the cordis loader does no transpilation). After editing `src/`, run `node build.mjs` and commit `lib/` with it — CI fails if the two drift apart.
- Tests run directly on TypeScript via `node --test src/*.test.ts`; `node:test` only, no test framework.
- Supported Node is pinned in `package.json` `engines` and exercised in CI at `22.19.0` and `24.x`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`Elefseus/dsh-pet-progress`), driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings, unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

single-context. See `docs/agents/domain.md`.

MIT
