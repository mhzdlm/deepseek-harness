/**
 * The model-facing `create_python_skill` tool (NEXT T2.3): the authoritative
 * last step of the skill-creation workflow. The model distills a repeated
 * workflow from the transcript (via `transcript.grep`), writes the package
 * files itself, then calls this tool to validate the package on disk and
 * register the harness entry under CAS. The next kernel provision installs it
 * (T2.1) and verifies it imports (T2.2).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HarnessEntry } from '@deepseek-ai/dsh-plugin-continual-harness'

const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/
const IMPORT_PATTERN = /^[a-z_][a-z0-9_]*$/

/** The CAS upsert the host assembly injects; owned by continual-harness. */
export type UpsertPythonSkillEntry = (
  baseDir: string,
  spec: { id: string; title: string; description: string; importName: string; callable?: string },
) => Promise<HarnessEntry>

export interface SkillCreateToolOptions {
  /** The rlm data dir owning both the skills tree and the harness state. */
  dataDir: string
  /** CAS registration function injected by the host assembly (index.ts). */
  upsert: UpsertPythonSkillEntry
}

/**
 * Validate that the package the model claims to have written actually exists
 * on disk, returning the list of concrete problems (empty when usable).
 */
export function validateSkillPackage(
  dataDir: string,
  id: string,
  importName: string,
): string[] {
  const problems: string[] = []
  const packagePath = path.join(dataDir, 'skills', id)
  const pyprojectPath = path.join(packagePath, 'pyproject.toml')
  if (!existsSync(pyprojectPath)) {
    problems.push(`missing ${pyprojectPath}`)
  }
  const moduleFile = path.join(packagePath, `${importName}.py`)
  const moduleDir = path.join(packagePath, importName, '__init__.py')
  if (!existsSync(moduleFile) && !existsSync(moduleDir)) {
    problems.push(`missing module body: ${moduleFile} (or ${importName}/__init__.py)`)
  }
  return problems
}

/**
 * Build the `create_python_skill` tool.
 * @param options - data dir owning the skills tree and harness state.
 */
export function createSkillCreateTool(options: SkillCreateToolOptions) {
  const { dataDir } = options
  return defineTool({
    name: 'create_python_skill',
    description:
      'Register a python-backed skill you have just written to disk, making it callable '
      + 'in the kernel as `await <import>(...)` after the next kernel provision. Workflow: '
      + '(1) use transcript.grep to identify the repeated workflow and its exact steps; '
      + '(2) write <dataDir>/skills/<name>/pyproject.toml (setuptools backend, name=<name>) '
      + 'plus the module <import_name>.py exposing an async run(...); '
      + '(3) call this tool with the same name/import_name/description. Fails loud when the '
      + 'files on disk do not match.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Slug id; package directory <dataDir>/skills/<name>.',
      },
      import_name: {
        type: 'string',
        required: true,
        description: 'Module name the kernel binds as a callable.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Human-facing skill title.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'What the skill does; rendered by the prompt layer for routing.',
      },
      callable: {
        type: 'string',
        description: 'Callable inside the module. Defaults to "run".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      if (!SLUG_PATTERN.test(args.name)) {
        throw new Error(`create_python_skill: name must match ${SLUG_PATTERN.source}`)
      }
      if (!IMPORT_PATTERN.test(args.import_name)) {
        throw new Error('create_python_skill: import_name must be a python identifier')
      }
      const problems = validateSkillPackage(dataDir, args.name, args.import_name)
      if (problems.length > 0) {
        throw new Error(
          `create_python_skill: package on disk does not match the request:\n${problems.map(p => `  - ${p}`).join('\n')}`,
        )
      }
      const entry = await options.upsert(dataDir, {
        id: args.name,
        title: args.title,
        description: args.description,
        importName: args.import_name,
        ...(args.callable !== undefined ? { callable: args.callable } : {}),
      })
      const text =
        `Registered python skill "${entry.id}" v${entry.version} (global scope). `
        + `It becomes callable as await ${args.import_name}(...) at the next kernel provision `
        + '(after idle reclaim, session restart, or a fresh session). '
        + 'Verify then by calling it once inside ipython.'
      return { text }
    },
  })
}
