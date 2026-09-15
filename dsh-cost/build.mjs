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
 * Usage: pnpm install (once, brings in the typescript devDependency), then
 *   node build.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const packageName = 'dsh-cost'

const tsc = join(root, 'node_modules', '.bin', 'tsc')
if (!existsSync(tsc)) {
  throw new Error(
    `build.mjs: ${tsc} not found.\n`
      + 'Install dependencies first: pnpm install.',
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
