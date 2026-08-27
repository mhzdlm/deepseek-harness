import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repo root is the parent of this script's directory (scripts/).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

// [source package dir (relative to repo), install package name (without scope)].
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

// Relative imports ending in one of these are resolved by the runtime or bundler
// and are not the deployment-breaking extensionless case. `.css` imports live in
// the unbundled lib/types/client/*.js but the runtime loads the bundled
// lib/client.js where rolldown has resolved them, so they are a false positive.
const KNOWN_EXT = /\.(js|ts|mjs|cjs|json|css|node|wasm)$/

function extensionlessRelativeImports(packageDir) {
  const bad = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) {
        const text = readFileSync(full, 'utf8')
        for (const line of text.split('\n')) {
          const m = line.match(/from\s*["'](\.[^"']*)["']/)
          if (m && !KNOWN_EXT.test(m[1])) bad.push(`${relative(packageDir, full)}: ${line.trim()}`)
        }
      }
    }
  }
  walk(join(packageDir, 'lib'))
  return bad
}

function getArg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

const deployRoot = getArg('--deploy-root')
if (!deployRoot) {
  console.error('usage: node scripts/verify-plugin-deploy.mjs --deploy-root <dir>')
  process.exit(2)
}
const deployNodeModules = join(deployRoot, 'node_modules', '@deepseek-ai')

let failures = 0
for (const [, target] of MAP) {
  const dir = join(deployNodeModules, target)
  if (!existsSync(join(dir, 'package.json'))) {
    console.error(`FAIL ${target}: package not found at ${dir}`)
    failures++
    continue
  }
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const main = pj.main || 'lib/index.js'
  const entry = join(dir, main)
  if (!existsSync(entry)) {
    console.error(`FAIL ${target}: missing main entry ${main}`)
    failures++
    continue
  }
  const bad = extensionlessRelativeImports(dir)
  if (bad.length > 0) {
    console.error(`FAIL ${target}: extensionless relative imports\n${bad.join('\n')}`)
    failures++
  } else {
    console.log(`ok ${target} (main=${main})`)
  }
}
process.exit(failures > 0 ? 1 : 0)
