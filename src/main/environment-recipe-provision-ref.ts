import { gitExecFileAsync } from './git/runner'

const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

type GitExec = (
  args: string[],
  options: { cwd: string }
) => Promise<{ stdout: string; stderr?: string }>

export type EnvironmentRecipeProvisionRefResolver = (args: {
  repoPath: string
  requestedRef?: string
  operatorCatalogEnabled: boolean
}) => Promise<string | undefined>

export async function resolveEnvironmentRecipeProvisionRef(
  args: {
    repoPath: string
    requestedRef?: string
    operatorCatalogEnabled: boolean
  },
  gitExec: GitExec = gitExecFileAsync
): Promise<string | undefined> {
  if (!args.operatorCatalogEnabled || args.requestedRef !== undefined) {
    return args.requestedRef
  }

  let stdout: string
  try {
    const result = await gitExec(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
      cwd: args.repoPath
    })
    stdout = result.stdout
  } catch {
    throw new Error('The target repository HEAD does not resolve to one commit.')
  }
  const objectId = stdout.trim()
  if (!FULL_OBJECT_ID_PATTERN.test(objectId)) {
    throw new Error('The target repository HEAD did not resolve to one full commit object ID.')
  }
  return objectId
}
