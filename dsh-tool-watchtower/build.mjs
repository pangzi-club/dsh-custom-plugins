/**
 * Build the host half into lib/ (v1: host only; the client half joins with
 * the live panel later). Output stages through .build/ so a failed compile
 * never leaves a half-updated lib/ behind.
 *
 * Usage: pnpm install (once, brings in the typescript devDependency), then
 *   node build.mjs
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

const tsc = join(root, 'node_modules', '.bin', 'tsc')
if (!existsSync(tsc)) {
  throw new Error(
    `build.mjs: ${tsc} not found.\n`
    + 'Install dependencies first: pnpm install.',
  )
}

rmSync(join(root, '.build'), { recursive: true, force: true })
execFileSync(tsc, ['-p', join(root, 'tsconfig.host.build.json')], { stdio: 'inherit' })
rmSync(join(root, 'lib'), { recursive: true, force: true })
mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, '.build', 'index.js'), join(root, 'lib', 'index.js'))
cpSync(join(root, '.build', 'host'), join(root, 'lib', 'host'), { recursive: true })
rmSync(join(root, '.build'), { recursive: true, force: true })
console.log('built lib/index.js + lib/host/')
