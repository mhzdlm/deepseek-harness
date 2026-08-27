import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

// Repo root is the parent of this script's directory (scripts/).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

// [source package dir (relative to repo), install package name (without scope)].
// The install name is the full `@deepseek-ai/dsh-<name>`; the source path basename
// omits the `dsh-` prefix and must not be used as the target directory name.
const MAP = [
  ['packages/extensions/cordis-host-runner', 'dsh-cordis-host-runner'],
  ['packages/extensions/cordis-client-runner', 'dsh-cordis-client-runner'],
  ['packages/extensions/tool-cordis', 'dsh-tool-cordis'],
  ['packages/extensions/ui-cordis', 'dsh-client-ui-cordis'],
  ['packages/client/ui-rlm', 'dsh-client-ui-rlm'],
  ['packages/host/plugin-inventory', 'dsh-host-plugin-inventory'],
  ['packages/client/runtime', 'dsh-client-runtime'],
  ['packages/core/session', 'dsh-session'],
  ['packages/llm/llm', 'dsh-llm'],
  ['packages/llm/llm-pi-ai', 'dsh-llm-pi-ai'],
  ['packages/bundle/web-app', 'dsh-web-app'],
]

function getArg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

const deployRoot = getArg('--deploy-root')
if (!deployRoot) {
  console.error('usage: node scripts/sync-plugin-mode-deploy.mjs --deploy-root <dir> [--skip-build] [--reapply-lan-guard]')
  process.exit(2)
}
const skipBuild = process.argv.includes('--skip-build')
const reapplyLanGuard = process.argv.includes('--reapply-lan-guard')
const deployNodeModules = join(deployRoot, 'node_modules', '@deepseek-ai')

function copyPackage(fromPkgDir, targetName) {
  const to = join(deployNodeModules, targetName)
  if (!existsSync(join(fromPkgDir, 'package.json'))) throw new Error(`source missing: ${fromPkgDir}`)
  rmSync(to, { recursive: true, force: true })
  // Node cpSync with a node_modules filter: PowerShell Copy-Item -Recurse descends
  // into nested pnpm symlinks and overflows the path, so never use it here.
  cpSync(fromPkgDir, to, {
    recursive: true,
    filter: (source) => basename(source) !== 'node_modules',
  })
}

// Re-apply the install-local DSH_PKG_ALLOW_LAN guard to web-app lib/startup.js.
// The guard is a local patch on the install and is absent from source, so every
// copy overwrites it. Idempotent: skips when already present, warns when the
// host-check line cannot be found (source shape changed).
function applyLanGuard(webAppStartup) {
  if (!existsSync(webAppStartup)) return
  let text = readFileSync(webAppStartup, 'utf8')
  if (text.includes('DSH_PKG_ALLOW_LAN')) {
    console.log('lan guard already present in startup.js; skipping')
    return
  }
  const ifRe = /(\s*)if\s*\(\s*options\.host\s*===\s*"0\.0\.0\.0"\s*\)\s*program\.error\(/g
  const replaced = text.replace(ifRe, (m, indent) =>
    `const allowLan = process.env.DSH_PKG_ALLOW_LAN === "1";\n${indent}if (options.host === "0.0.0.0" && !allowLan) program.error(`)
  if (replaced === text) {
    console.warn('WARN: host-check line not found in startup.js; skipping LAN guard re-apply')
    return
  }
  writeFileSync(webAppStartup, replaced)
  console.log('re-applied DSH_PKG_ALLOW_LAN guard to web-app startup.js')
}

if (!skipBuild) {
  console.log('building workspace (pnpm run build:lib)...')
  execSync('pnpm run build:lib', { cwd: REPO_ROOT, stdio: 'inherit' })
}

for (const [from, target] of MAP) {
  const fromPkg = join(REPO_ROOT, from)
  if (!existsSync(join(fromPkg, 'package.json'))) {
    console.error(`SKIP (no package.json): ${from}`)
    continue
  }
  copyPackage(fromPkg, target)
  console.log(`synced: ${target}  (from ${from})`)
  if (reapplyLanGuard && target === 'dsh-web-app') {
    applyLanGuard(join(deployNodeModules, target, 'lib', 'startup.js'))
  }
}
console.log('DONE plugin-mode sync')
