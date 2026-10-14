/**
 * Wire-contract test: every bubble this plugin can render must survive the
 * pet's real `parseAnnouncement` validator, unchanged in the fields the user
 * sees. This is the seam a pure-projection test cannot cover — the pet is the
 * one that decides whether a payload renders at all, and it silently DROPS
 * anything malformed, so a wrong `kind` or a missing `percent` would show up as
 * a pet with no progress bubble rather than as an error.
 *
 * Run: node --test src/wire.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { renderBubble, foldProgressEvent, PROGRESS_TTL_MS } from './progress.ts'

/**
 * Load the pet's real validator. It is not re-exported from the package index
 * (the build inlines it), so the constants and the `parseAnnouncement` /
 * `boundedString$1` functions are sliced out of the bundle by line number and
 * evaluated. Slicing by line rather than by a single regex keeps this working
 * when the bundler reorders the declarations — which it already does, since the
 * constants are emitted `TITLE_MAX$1, TEXT_MAX, SOURCE_MAX` with the helper
 * between them.
 *
 * If the pet ever restructures that bundle this throws loudly instead of
 * silently testing nothing.
 */
/**
 * Locate the pet's built bundle, or `undefined` when it is not installed.
 *
 * This test validates our bubbles against the pet's REAL validator, which only
 * exists inside a dsh profile that has the pet installed. There is no portable
 * way to obtain it — the pet is a peer dependency, and its validator is inlined
 * into its bundle rather than exported — so on a machine (or CI runner) without
 * the pet, this suite must SKIP rather than fail. A hardcoded path here would
 * make the suite green only on the machine it was written on, which is worse
 * than skipping: it would report a passing wire contract that was never checked.
 *
 * Override with `DSH_PET_LIB=<path to @linxin666/dsh-pet/lib/index.js>`.
 */
function findPetLib(): string | undefined {
  const candidates = [
    process.env['DSH_PET_LIB'],
    // Profile-local install (the normal case).
    ...(process.env['DSH_HOME']
      ? [`${process.env['DSH_HOME']}/profiles/desktop/node_modules/@linxin666/dsh-pet/lib/index.js`]
      : []),
    // A checkout sitting next to this one, and the plain node_modules layout,
    // so `npm install` in a fork is enough to enable the suite.
    new URL('../node_modules/@linxin666/dsh-pet/lib/index.js', import.meta.url).pathname,
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not there; try the next candidate.
    }
  }
  return undefined
}

function loadPetValidator(): {
  parseAnnouncement: (input: unknown, now: number) => Record<string, unknown> | undefined
  ANNOUNCE_MAX_TTL_MS: number
} | undefined {
  const petLib = findPetLib()
  if (petLib === undefined) return undefined
  const lines = readFileSync(petLib, 'utf8').split('\n')

  /** Collect one `function name(...) { ... }` body by brace matching. */
  const takeFunction = (name: string): string => {
    const start = lines.findIndex(line => line.startsWith(`function ${name}(`))
    if (start === -1) throw new Error(`pet bundle layout changed: no function ${name}`)
    let depth = 0
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]!) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
      if (depth === 0 && i > start) return lines.slice(start, i + 1).join('\n')
    }
    throw new Error(`pet bundle layout changed: unbalanced braces in ${name}`)
  }

  /** Collect one `const NAME = <literal>;` declaration's value. */
  const takeConst = (name: string): string => {
    const re = new RegExp(`^const ${name.replace('$', '\\$')} = (.+);$`)
    for (const line of lines) {
      const m = re.exec(line)
      if (m) return m[1]!
    }
    throw new Error(`pet bundle layout changed: no const ${name}`)
  }

  const code = `
    const TITLE_MAX$1 = ${takeConst('TITLE_MAX$1')}, TEXT_MAX = ${takeConst('TEXT_MAX')}, SOURCE_MAX = ${takeConst('SOURCE_MAX')};
    const ANNOUNCE_DEFAULT_TTL_MS = ${takeConst('ANNOUNCE_DEFAULT_TTL_MS')}, ANNOUNCE_MAX_TTL_MS = ${takeConst('ANNOUNCE_MAX_TTL_MS')};
    ${takeFunction('boundedString$1')}
    ${takeFunction('parseAnnouncement')}
    return { parseAnnouncement, ANNOUNCE_MAX_TTL_MS };
  `
  return new Function(code)() as Exclude<ReturnType<typeof loadPetValidator>, undefined>
}

const pet = loadPetValidator()
const now = Date.now()

/** Validate one rendered bubble the way the host will. */
function throughPet(bubble: ReturnType<typeof renderBubble>) {
  assert.ok(bubble, 'renderBubble produced nothing')
  assert.ok(pet, 'wire suite ran without the pet validator loaded')
  return pet.parseAnnouncement(
    {
      source: 'pet-progress',
      kind: 'plan',
      title: bubble.title,
      percent: bubble.percent,
      tone: bubble.tone,
      note: bubble.note,
      ttlMs: PROGRESS_TTL_MS,
    },
    now,
  )
}

describe('bubble wire contract', { skip: pet === undefined ? 'the pet is not installed; set DSH_PET_LIB to run this suite' : false }, () => {
  it('renders a blocked goal into a payload the pet accepts', () => {
    const fold = foldProgressEvent(undefined, 'goal/change', {
      operation: 'block',
      goal: {
        objective: '部署',
        phase: 'blocked',
        maxGoalRounds: 4,
        blockedReason: { code: 'needs-key', message: '需要 API 密钥' },
      },
      roundsStarted: 1,
    })
    assert.equal(fold.kind, 'view')
    const parsed = throughPet(renderBubble(fold.kind === 'view' ? fold.view : undefined))
    assert.ok(parsed, 'pet REJECTED the blocked-goal bubble')
    assert.equal(parsed['kind'], 'plan')
    assert.equal(parsed['note'], '受阻')
    assert.equal(parsed['tone'], 'low')
    assert.equal(parsed['title'], '需要 API 密钥')
    assert.equal(typeof parsed['percent'], 'number')
  })

  it('renders an active goal with no round budget into an accepted payload', () => {
    // The risky case: goalPercent() returns 0 here, and a `plan` payload is
    // rejected outright when percent is absent. 0 must survive as 0.
    const fold = foldProgressEvent(undefined, 'goal/change', {
      operation: 'create',
      goal: { objective: '长期重构', phase: 'active', maxGoalRounds: 0 },
      roundsStarted: 0,
    })
    assert.equal(fold.kind, 'view')
    const view = fold.kind === 'view' ? fold.view : undefined
    assert.equal(view?.percent, 0)
    const parsed = throughPet(renderBubble(view))
    assert.ok(parsed, 'pet REJECTED a percent:0 goal bubble')
    assert.equal(parsed['percent'], 0)
    assert.equal(parsed['note'], '目标进行中')
  })

  it('keeps a completed goal at percent 100', () => {
    const fold = foldProgressEvent(undefined, 'goal/change', {
      operation: 'complete',
      goal: { objective: '发布 v2', phase: 'complete', maxGoalRounds: 8 },
      roundsStarted: 8,
    })
    const parsed = throughPet(renderBubble(fold.kind === 'view' ? fold.view : undefined))
    assert.ok(parsed)
    assert.equal(parsed['percent'], 100)
    assert.equal(parsed['tone'], 'ok')
  })

  it('accepts every tone the renderer emits', () => {
    const tones = new Set<string>()
    const payloads = [
      { operation: 'block', goal: { objective: 'a', phase: 'blocked', blockedReason: { message: 'why' } } },
      { operation: 'create', goal: { objective: 'b', phase: 'active', maxGoalRounds: 2 } },
      { operation: 'pause', goal: { objective: 'c', phase: 'paused' } },
    ]
    for (const p of payloads) {
      const fold = foldProgressEvent(undefined, 'goal/change', p)
      const bubble = renderBubble(fold.kind === 'view' ? fold.view : undefined)
      if (bubble) tones.add(bubble.tone)
    }
    assert.deepEqual([...tones].sort(), ['low', 'warn'])
    for (const tone of tones) {
      assert.ok(['ok', 'warn', 'low'].includes(tone), `tone ${tone} is not in the pet vocabulary`)
    }
  })

  it('bounds the title and note the way the pet would', () => {
    const long = '这是一个非常长的任务标题'.repeat(40)
    const fold = foldProgressEvent(undefined, 'todo/write', {
      todos: [{ content: long, status: 'in_progress' }],
    })
    const bubble = renderBubble(fold.kind === 'view' ? fold.view : undefined)
    assert.ok(bubble)
    const parsed = throughPet(bubble)
    assert.ok(parsed, 'pet rejected an over-long title')
    // The pet truncates rather than rejecting; our own compactText already bit
    // it below the pet's bound, so the two never disagree about the text.
    assert.ok((parsed['title'] as string).length <= bubble.title.length + 1)
    assert.ok((parsed['note'] as string).length <= 80)
  })
})
