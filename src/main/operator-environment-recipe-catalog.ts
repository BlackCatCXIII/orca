import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import type { OperatorRecipeCatalogStatus } from '../shared/operator-recipe-catalog-status'
import { parseOperatorCatalogJson } from './operator-catalog-strict-json'
import {
  OperatorRecipeCatalogError,
  PRODUCTION_OPERATOR_CATALOG_FILE_SYSTEM,
  readVerifiedOperatorCatalogFile,
  type OperatorRecipeCatalogFileSystem
} from './operator-catalog-verified-file'

export { OperatorRecipeCatalogError }
export type { OperatorRecipeCatalogFileSystem }

const MAX_CATALOG_BYTES = 64 * 1024
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SCRIPT_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

const ScriptSchema = z
  .object({
    path: z.string().min(1).max(256),
    sha256: z.string().regex(SHA256_PATTERN)
  })
  .strict()

const RecipeSchema = z
  .object({
    id: z.string().regex(RECIPE_ID_PATTERN),
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(512).optional(),
    checkoutMode: z.literal('provisioned-root'),
    lifecycle: z
      .object({
        create: ScriptSchema,
        suspend: ScriptSchema.optional(),
        resume: ScriptSchema.optional(),
        destroy: ScriptSchema.optional()
      })
      .strict()
  })
  .strict()

const CatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    recipes: z.array(RecipeSchema).min(1).max(32)
  })
  .strict()

type CatalogDocument = z.infer<typeof CatalogSchema>
type CatalogRecipe = CatalogDocument['recipes'][number]

export type OperatorEnvironmentRecipeCatalog = Readonly<{
  status: OperatorRecipeCatalogStatus
  listRecipes(): readonly OrcaVmRecipe[]
  resolveRecipe(recipeId: string): OrcaVmRecipe | null
}>

export function loadOperatorEnvironmentRecipeCatalog(args: {
  catalogPath: string
  sha256: string
  fileSystem?: OperatorRecipeCatalogFileSystem
}): OperatorEnvironmentRecipeCatalog {
  const fileSystem = args.fileSystem ?? PRODUCTION_OPERATOR_CATALOG_FILE_SYSTEM
  const loaded = readCatalog(args.catalogPath, args.sha256, fileSystem)
  const status: OperatorRecipeCatalogStatus = Object.freeze({
    enabled: true,
    digest: args.sha256,
    recipeIds: Object.freeze(loaded.document.recipes.map((recipe) => recipe.id).sort())
  })

  const reload = (): LoadedCatalog => readCatalog(args.catalogPath, args.sha256, fileSystem)
  return Object.freeze({
    status,
    listRecipes: () => reload().recipes,
    resolveRecipe: (recipeId) => reload().recipes.find((recipe) => recipe.id === recipeId) ?? null
  })
}

type LoadedCatalog = {
  document: CatalogDocument
  recipes: OrcaVmRecipe[]
}

function readCatalog(
  catalogPath: string,
  expectedDigest: string,
  fileSystem: OperatorRecipeCatalogFileSystem
): LoadedCatalog {
  if (!SHA256_PATTERN.test(expectedDigest)) {
    throw new OperatorRecipeCatalogError(
      'Operator recipe catalog digest must be lowercase SHA-256.'
    )
  }
  if (!isAbsolute(catalogPath) || resolve(catalogPath) !== catalogPath) {
    throw new OperatorRecipeCatalogError(
      'Operator recipe catalog path must be absolute and normalized.'
    )
  }

  const catalogBytes = readVerifiedOperatorCatalogFile(
    catalogPath,
    MAX_CATALOG_BYTES,
    fileSystem,
    false
  )
  if (sha256(catalogBytes) !== expectedDigest) {
    throw new OperatorRecipeCatalogError('Operator recipe catalog digest mismatch.')
  }

  let document: CatalogDocument
  try {
    document = CatalogSchema.parse(parseOperatorCatalogJson(catalogBytes.toString('utf8')))
  } catch {
    throw new OperatorRecipeCatalogError('Operator recipe catalog contract is invalid.')
  }
  verifyUniqueCatalogFields(document)

  const catalogRoot = dirname(catalogPath)
  const recipes = document.recipes.map((recipe) => toRuntimeRecipe(recipe, catalogRoot, fileSystem))
  return { document, recipes }
}

function verifyUniqueCatalogFields(document: CatalogDocument): void {
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const recipe of document.recipes) {
    if (ids.has(recipe.id)) {
      throw new OperatorRecipeCatalogError('Operator recipe catalog contains duplicate recipe IDs.')
    }
    ids.add(recipe.id)
    for (const script of Object.values(recipe.lifecycle)) {
      validateRelativeScriptPath(script.path)
      if (paths.has(script.path)) {
        throw new OperatorRecipeCatalogError(
          'Operator recipe catalog contains duplicate script paths.'
        )
      }
      paths.add(script.path)
    }
  }
}

function validateRelativeScriptPath(path: string): void {
  if (
    !SCRIPT_PATH_PATTERN.test(path) ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '.' || segment === '..') ||
    hasControlCharacter(path)
  ) {
    throw new OperatorRecipeCatalogError('Operator recipe catalog contains an unsafe script path.')
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function toRuntimeRecipe(
  recipe: CatalogRecipe,
  catalogRoot: string,
  fileSystem: OperatorRecipeCatalogFileSystem
): OrcaVmRecipe {
  const resolveScript = (script: z.infer<typeof ScriptSchema> | undefined): string | undefined => {
    if (!script) {
      return undefined
    }
    const absolutePath = join(catalogRoot, ...script.path.split('/'))
    const relativePath = relative(catalogRoot, absolutePath)
    if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new OperatorRecipeCatalogError('Operator recipe catalog script escaped its root.')
    }
    const bytes = readVerifiedOperatorCatalogFile(absolutePath, MAX_SCRIPT_BYTES, fileSystem, true)
    if (sha256(bytes) !== script.sha256) {
      throw new OperatorRecipeCatalogError('Operator recipe catalog script digest mismatch.')
    }
    return absolutePath
  }

  return {
    id: recipe.id,
    name: recipe.name,
    ...(recipe.description ? { description: recipe.description } : {}),
    checkoutMode: 'provisioned-root',
    create: resolveScript(recipe.lifecycle.create)!,
    ...(recipe.lifecycle.suspend ? { suspend: resolveScript(recipe.lifecycle.suspend) } : {}),
    ...(recipe.lifecycle.resume ? { resume: resolveScript(recipe.lifecycle.resume) } : {}),
    ...(recipe.lifecycle.destroy ? { destroy: resolveScript(recipe.lifecycle.destroy) } : {})
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
