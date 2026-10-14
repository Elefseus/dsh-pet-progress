# dsh-pet-progress

Progress companion for the [dsh web pet](https://github.com/zhu1090093659/dsh-pet): reads the durable `todo/write` and `goal/change` events the pet ignores, and folds them into a percentage bubble.

- [English README](./README.md)
- [中文说明](./README.zh.md)

```bash
node build.mjs              # rebuild lib/ from src/ (only needed after editing src/)
node --test src/*.test.ts    # 48 tests, no framework beyond node:test
```

MIT
