// One-off dev tool: refresh ~/.prime/agent/kernel-venv/.bootstrap-version so
// kernelReady() matches the CURRENT vendored prime-agent-runtime source hash
// (kept as a checked-in script so the next source change can re-run it).
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VENV = 'C:/Users/mhzdl/.prime/agent/kernel-venv'
const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'prime-agent-runtime')
const EXTRA_UV_ARGS = ['requests', 'httpx', 'pyyaml', 'tomli', 'python-dotenv', 'pandas', 'numpy', 'scipy', 'beautifulsoup4', 'lxml', 'pydantic', 'tyro']

async function hashRuntimeSource(sourceDir: string): Promise<string> {
  const rlmDir = path.join(sourceDir, 'src', 'rlm')
  const files: string[] = [path.join(sourceDir, 'pyproject.toml')]
  async function collect(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await collect(full)
      else if (entry.isFile() && entry.name.endsWith('.py')) files.push(full)
    }
  }
  await collect(rlmDir)
  files.sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(path.relative(sourceDir, file))
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

const version = {
  schema: 8,
  ipykernel: 'ipykernel',
  runtime: await hashRuntimeSource(SOURCE),
  snapshot: 'dill',
  extraUvArgs: EXTRA_UV_ARGS,
  pythonSkills: [],
}
await mkdir(VENV, { recursive: true })
await writeFile(path.join(VENV, '.bootstrap-version'), `${JSON.stringify(version)}\n`, 'utf8')
console.log('refreshed', version.runtime)
