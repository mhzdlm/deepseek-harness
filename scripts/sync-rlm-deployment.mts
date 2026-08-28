#!/usr/bin/env node
/**
 * Sync freshly built rlm plugin packages into a DeepSeek Harness deployment
 * tree (for example the desktop app's `dependencies\dsh`), reproducing the
 * manual install: copy the five packages (never their node_modules), make the
 * runtime dependencies resolvable, and verify the compiled output loads under
 * plain Node — no extensionless relative imports, entries present.
 *
 * The five packages are consumed as plain dependencies referenced by a locally
 * authored agent preset; they intentionally declare no dsh.bundle (the bundle
 * layer is host-plane, while these rows belong to an agent preset).
 *
 * Usage:
 *   pnpm exec tsx scripts/sync-rlm-deployment.mts --deploy-root <dir> [options]
 *
 * Options:
 *   --deploy-root <dir>   Deployment tree whose node_modules receives the packages. Required.
 *   --deps-from <dir>     Flat node_modules to copy zeromq/uuid/cmake-ts/node-addon-api from.
 *                         Required only when a dependency is missing from the target and
 *                         no junction for it exists yet (e.g. first sync on a machine).
 *   --skip-build          Assume `pnpm run build` already ran.
 *   --skip-verify         Skip the compiled-output verification scan (not recommended).
 *
 * Exit codes: 0 success; 1 any check failed.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const PACKAGES = [
  'dsh-plugin-rlm-kernel',
  'dsh-plugin-continual-harness',
  'dsh-plugin-rlm-verifier',
  'dsh-plugin-rlm-moa',
  'dsh-plugin-rlm-loop',
] as const

const SCOPED = `@deepseek-ai/`

const RUNTIME_DEPS = ['zeromq', 'uuid', 'cmake-ts', 'node-addon-api'] as const

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

interface Options {
  deployRoot: string | undefined
  depsFrom: string | undefined
  skipBuild: boolean
  skipVerify: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { deployRoot: undefined, depsFrom: undefined, skipBuild: false, skipVerify: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--deploy-root') options.deployRoot = argv[++i]
    else if (arg === '--deps-from') options.depsFrom = argv[++i]
    else if (arg === '--skip-build') options.skipBuild = true
    else if (arg === '--skip-verify') options.skipVerify = true
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('See the header comment of scripts/sync-rlm-deployment.mts.\n')
      process.exit(0)
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`)
      process.exit(1)
    }
  }
  return options
}

function fail(message: string): never {
  process.stderr.write(`sync-rlm: ${message}\n`)
  process.exit(1)
}

/**
 * robocopy-free recursive copy; refuses to descend into node_modules.
 * `targetName` is the deployed package name (e.g. `dsh-plugin-rlm-kernel`), which
 * differs from the source directory basename (`plugin-rlm-kernel`): copying under
 * the wrong name silently lands the package where the loader never reads it.
 */
function copyPackage(fromPkgDir: string, targetName: string, deployNodeModules: string): void {
  const to = path.join(deployNodeModules, SCOPED + targetName)
  if (!existsSync(path.join(fromPkgDir, 'package.json'))) fail(`source package missing: ${fromPkgDir}`)
  rmSync(to, { recursive: true, force: true })
  cpSync(fromPkgDir, to, {
    recursive: true,
    filter: source => path.basename(source) !== 'node_modules',
  })
}

/** Collect relative import specifiers that tsc would have rewritten but did not. */
function extensionlessRelativeImports(packageDir: string): string[] {
  const bad: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) {
        const text = readFileSync(full, 'utf8')
        const re = /^[ \t]*import[^;\n]*from\s*["']\.[^"']*(?<!\.js)["']/gm
        for (const line of text.split('\n')) if (re.test(line)) bad.push(`${path.relative(packageDir, full)}: ${line.trim()}`)
      }
    }
  }
  walk(path.join(packageDir, 'lib'))
  return bad
}

const options = parseArgs(process.argv.slice(2))
if (!options.deployRoot) fail('--deploy-root is required')
const deployNodeModules = path.resolve(options.deployRoot, 'node_modules')
if (!existsSync(deployNodeModules)) fail(`deployment node_modules not found: ${deployNodeModules}`)

if (!options.skipBuild) {
  console.log('[1/4] pnpm run build')
  // pnpm ships as a .cmd shim on Windows: spawning it bare raises EINVAL under
  // the same Node mitigation that motivated vendor patch #16, so the win32
  // path goes through the shell — with a fixed argv array, never a composed
  // command string.
  const build = spawnSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (build.status !== 0) fail('build failed')
} else {
  console.log('[1/4] skipping build (--skip-build)')
}

console.log('[2/4] copying five packages into the deployment tree')
for (const name of PACKAGES) {
  const pkgDir = path.join(REPO_ROOT, 'packages', 'rlm', name.replace('dsh-plugin-', 'plugin-'))
  copyPackage(pkgDir, name, deployNodeModules)
}

console.log('[3/4] runtime dependencies')
const missingDeps = RUNTIME_DEPS.filter(dep => !existsSync(path.join(deployNodeModules, dep)))
if (missingDeps.length > 0) {
  if (!options.depsFrom) fail(`missing runtime deps (${missingDeps.join(', ')}) — pass --deps-from <flat node_modules> (e.g. the rlm profile's node_modules)`)
  for (const dep of missingDeps) {
    const from = path.join(options.depsFrom, dep)
    if (!existsSync(from)) fail(`--deps-from has no ${dep}: ${from}`)
    cpSync(from, path.join(deployNodeModules, dep), { recursive: true })
    console.log(`  copied ${dep}`)
  }
} else {
  console.log('  all present')
}

let failures = 0
if (!options.skipVerify) {
  console.log('[4/4] verifying compiled output')
  for (const name of PACKAGES) {
    const dir = path.join(deployNodeModules, SCOPED + name)
    const entry = path.join(dir, 'lib', 'types', 'index.js')
    if (!existsSync(entry)) { process.stderr.write(`FAIL ${name}: missing lib/types/index.js\n`); failures++; continue }
    const bad = extensionlessRelativeImports(dir)
    if (bad.length > 0) { process.stderr.write(`FAIL ${name}: extensionless relative imports\n${bad.join('\n')}\n`); failures++ }
    else console.log(`  ok ${name}`)
  }
}

if (failures > 0) {
  process.stderr.write(`\nsync-rlm: ${failures} package(s) failed verification.\n`)
  process.exit(1)
}
console.log('\nsync-rlm: deployment updated.')
