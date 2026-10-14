/**
 * Build step for dsh-pet-progress.
 *
 * The cordis plugin loader does no transpilation, so the plugin's entry must be
 * plain JavaScript — a `main` pointing at a `.ts` file would simply fail to
 * mount. Rather than pull in a toolchain (esbuild/tsdown are not available in
 * this workspace), this uses Node's own TypeScript transformer, the same one it
 * uses to run `.ts` files directly, so the emitted JS matches what the runtime
 * would have done anyway.
 *
 * Two things the transformer does NOT do, and this script therefore does:
 *   - rewrite relative import specifiers, because the emitted `.js` must import
 *     `.js` siblings while the sources import `./progress.ts`;
 *   - emit anything at all, since `stripTypeScriptTypes` is a pure string
 *     transform.
 *
 * `mode: 'strip'` is used rather than `'transform'` because the sources contain
 * no enums, namespaces, or parameter properties — only erasable syntax — so the
 * lighter transform is sufficient and preserves the code as written.
 *
 * Run: node build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

const root = import.meta.dirname
const outDir = join(root, 'lib')
mkdirSync(outDir, { recursive: true })

/** Modules to emit, in dependency order. */
const MODULES = ['progress', 'index']

for (const name of MODULES) {
  const source = readFileSync(join(root, 'src', `${name}.ts`), 'utf8')

  // Relative specifiers must point at the emitted siblings, not the sources.
  // The replacement is a function, not a `$1`-style string: `progress.ts` also
  // appears in prose (module docblocks), and `$` handling in a template
  // replacement is error-prone. Only quoted specifiers are touched.
  const fixed = source.replace(/(['"])(\.\/[^'"]+?)\.ts\1/g, (_match, quote, spec) => `${quote}${spec}.js${quote}`)

  const code = stripTypeScriptTypes(fixed, { mode: 'strip', sourceMap: false })
  writeFileSync(join(outDir, `${name}.js`), code)
  console.log(`emitted lib/${name}.js (${code.length} bytes)`)
}

console.log('build ok')
