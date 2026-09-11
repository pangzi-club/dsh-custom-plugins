/**
 * Build the browser half into the loader's bundle envelope.
 *
 * The plugin lives outside the repository workspace, so it cannot use the
 * repository's `clientBundle` tsdown preset (that preset resolves a package
 * manifest from `packages/<group>/<package>`). It needs no bundler: the client
 * source is one file with no relative imports, `tsc` compiles it to CommonJS,
 * and this script wraps the emitted module in the documented
 * `window.__ModuleLoader__.load({ id, factory })` handoff. Bare specifiers stay
 * `require(...)` calls, answered by the loader's module table (React,
 * react-dom, and `@deepseek-ai/dsh-client-ui-primitives` are baseline rows).
 *
 * Usage: node build.mjs
 *   The DSH checkout that owns `tsc` is machine-local: set DSH_REPO, or write
 *   the path into the git-ignored `.dsh-repo` file next to this script.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const packageName = 'dsh-cost'

/**
 * Resolve the checkout that provides `tsc`: env first, then the local pointer
 * file, then an actionable failure. The path is deliberately machine-local, so
 * nothing personal is committed.
 * @returns the configured checkout path.
 */
function resolveRepo() {
  const configured = process.env.DSH_REPO?.trim()
  if (configured) return configured
  const pointer = join(root, '.dsh-repo')
  if (existsSync(pointer)) {
    const fromFile = readFileSync(pointer, 'utf8').trim()
    if (fromFile) return fromFile
  }
  throw new Error(
    'build.mjs: no deepseek-harness checkout configured.\n'
      + `Set DSH_REPO=/path/to/deepseek-harness, or write that path into ${pointer} (git-ignored).`,
  )
}

const repo = resolveRepo()
const tsc = join(repo, 'node_modules', '.bin', 'tsc')
if (!existsSync(tsc)) {
  throw new Error(
    `build.mjs: ${tsc} not found.\n`
      + 'Point DSH_REPO at a deepseek-harness checkout whose dependencies are installed (pnpm install).',
  )
}

execFileSync(tsc, ['-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })

const emitted = join(root, '.build', 'client', 'index.js')
const moduleSource = readFileSync(emitted, 'utf8')
const banner = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(packageName)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n`
const footer = '\n\t\treturn module.exports;\n\t}\n});\n'

mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), banner + moduleSource + footer)
rmSync(join(root, '.build'), { recursive: true, force: true })
console.log(`built lib/client.js (${(banner + moduleSource + footer).length} bytes)`)
