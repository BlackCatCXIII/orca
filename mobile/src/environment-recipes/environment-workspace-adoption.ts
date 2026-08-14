import type { Project, ProjectHostSetupResult } from '../../../src/shared/project-types'
import type { Repo } from '../../../src/shared/repo-types'
import type { EnvironmentRecipeRuntime } from '../../../src/shared/environment-recipe-runtime-rpc'
import { EnvironmentRecipeClientError } from '../../../src/shared/environment-recipe-client'
import type { RpcClient } from '../transport/rpc-client'

export type MobileEnvironmentRecipeCatalog = { repos: Repo[]; projects: Project[] }

export async function loadMobileEnvironmentRecipeCapabilities(
  client: RpcClient
): Promise<readonly string[]> {
  const response = await client.sendRequest('status.get')
  if (!response.ok) {
    return []
  }
  const result = response.result as { capabilities?: unknown }
  return Array.isArray(result.capabilities)
    ? result.capabilities.filter((item): item is string => typeof item === 'string')
    : []
}

export async function loadMobileEnvironmentRecipeCatalog(
  client: RpcClient
): Promise<MobileEnvironmentRecipeCatalog> {
  const [repos, projects] = await Promise.all([
    client.sendRequest('repo.list'),
    client.sendRequest('project.list')
  ])
  if (!repos.ok || !projects.ok) {
    throw new Error('catalog_failed')
  }
  return {
    repos: ((repos.result as { repos?: Repo[] }).repos ?? []).filter(
      (repo) => repo.kind !== 'folder'
    ),
    projects: (projects.result as { projects?: Project[] }).projects ?? []
  }
}

export async function adoptMobileEnvironmentWorkspace(
  client: RpcClient,
  runtime: EnvironmentRecipeRuntime,
  projects: Project[]
): Promise<{ id: string; name: string }> {
  if (runtime.status !== 'running' || runtime.connectionType !== 'ssh' || !runtime.adoption) {
    throw new Error('adoption_unavailable')
  }
  const adoption = runtime.adoption
  const project = projects.find((candidate) => candidate.sourceRepoIds.includes(runtime.repoId))
  if (!project) {
    throw new Error('project_unavailable')
  }
  const name = runtime.workspaceName ?? project.displayName
  const setupResponse = await client.sendRequest('projectHostSetup.setupExistingFolder', {
    projectId: project.id,
    hostId: adoption.executionHostId,
    path: adoption.expectedPath,
    displayName: name,
    setupMethod: 'imported-existing-folder'
  })
  if (!setupResponse.ok) {
    throw new Error('adoption_failed')
  }
  const setup = (setupResponse.result as { result: ProjectHostSetupResult }).result
  const createResponse = await client.sendRequest(
    'worktree.create',
    {
      repo: `id:${setup.repo.id}`,
      name,
      displayName: name,
      activate: true,
      clientMutationId: `environment-runtime-adopt:${runtime.runtimeId}`,
      provisionedRoot: {
        runtimeId: runtime.runtimeId,
        executionHostId: adoption.executionHostId,
        expectedPath: adoption.expectedPath
      }
    },
    { timeoutMs: 10 * 60_000 }
  )
  if (!createResponse.ok) {
    throw new Error('adoption_failed')
  }
  const worktree = (createResponse.result as { worktree: { id: string } }).worktree
  return { id: worktree.id, name }
}

export function safeEnvironmentWorkspaceMessage(reason: unknown): string {
  return reason instanceof EnvironmentRecipeClientError
    ? reason.message
    : 'Environment workspace operation failed on the runtime host.'
}
