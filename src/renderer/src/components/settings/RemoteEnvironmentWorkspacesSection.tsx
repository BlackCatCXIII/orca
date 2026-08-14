import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Project, ProjectHostSetupResult } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type {
  EnvironmentRecipeDescriptor,
  EnvironmentRecipeRuntime
} from '../../../../shared/environment-recipe-runtime-rpc'
import { EnvironmentRecipeClientError } from '../../../../shared/environment-recipe-client'
import { EnvironmentRecipeOperationGate } from '../../../../shared/environment-recipe-operation-gate'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  desktopSupportsEnvironmentRecipeLifecycle,
  destroyDesktopEnvironmentRecipe,
  listDesktopEnvironmentRecipeRuntimes,
  listDesktopEnvironmentRecipes,
  provisionDesktopEnvironmentRecipe,
  resumeDesktopEnvironmentRecipe,
  suspendDesktopEnvironmentRecipe
} from '@/runtime/environment-recipe-runtime-client'
import {
  clearDesktopEnvironmentRecipeMutation,
  loadDesktopEnvironmentRecipeMutation,
  saveDesktopEnvironmentRecipeMutation
} from '@/runtime/environment-recipe-mutation-journal'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { remoteEnvironmentWorkspacesCopy as copy } from './remote-environment-workspaces-copy'

type Catalog = { repos: Repo[]; projects: Project[] }

export function RemoteEnvironmentWorkspacesSection({ environmentId }: { environmentId: string }) {
  const operationGateRef = useRef(new EnvironmentRecipeOperationGate())
  const [supported, setSupported] = useState<boolean | null>(null)
  const [catalog, setCatalog] = useState<Catalog>({ repos: [], projects: [] })
  const [repoId, setRepoId] = useState('')
  const [recipes, setRecipes] = useState<EnvironmentRecipeDescriptor[]>([])
  const [recipeId, setRecipeId] = useState('')
  const [runtimes, setRuntimes] = useState<EnvironmentRecipeRuntime[]>([])
  const [busy, setBusy] = useState(false)
  const [destroyTarget, setDestroyTarget] = useState<EnvironmentRecipeRuntime | null>(null)

  const refreshCatalog = useCallback(async () => {
    setSupported(null)
    try {
      const nextSupported = await desktopSupportsEnvironmentRecipeLifecycle(environmentId)
      setSupported(nextSupported)
      if (!nextSupported) {
        return
      }
      const target = { kind: 'environment' as const, environmentId }
      const [repoResult, projectResult] = await Promise.all([
        callRuntimeRpc<{ repos: Repo[] }>(target, 'repo.list'),
        callRuntimeRpc<{ projects: Project[] }>(target, 'project.list')
      ])
      const nextCatalog = {
        repos: repoResult.repos.filter((repo) => repo.kind !== 'folder'),
        projects: projectResult.projects
      }
      setCatalog(nextCatalog)
      setRepoId((current) =>
        nextCatalog.repos.some((repo) => repo.id === current)
          ? current
          : (nextCatalog.repos[0]?.id ?? '')
      )
    } catch {
      setSupported(false)
      toast.error(copy.loadError)
    }
  }, [environmentId])

  const refreshRepo = useCallback(async () => {
    if (!repoId || supported !== true) {
      return
    }
    try {
      const [recipeCatalog, runtimeCatalog] = await Promise.all([
        listDesktopEnvironmentRecipes(environmentId, repoId),
        listDesktopEnvironmentRecipeRuntimes(environmentId, repoId)
      ])
      const eligible = recipeCatalog.recipes.filter(
        (recipe) => recipe.checkoutMode === 'provisioned-root'
      )
      setRecipes(eligible)
      setRuntimes(runtimeCatalog.runtimes.filter((runtime) => runtime.status !== 'cleaned'))
      setRecipeId((current) =>
        eligible.some((recipe) => recipe.recipeId === current)
          ? current
          : (eligible[0]?.recipeId ?? '')
      )
    } catch (reason) {
      toast.error(safeMessage(reason))
    }
  }, [environmentId, repoId, supported])

  useEffect(() => void refreshCatalog(), [refreshCatalog])
  useEffect(() => void refreshRepo(), [refreshRepo])

  const runExclusive = useCallback(
    async (operation: () => Promise<void>): Promise<void> => {
      await operationGateRef.current.run(async () => {
        setBusy(true)
        try {
          await operation()
          await refreshRepo()
        } catch (reason) {
          toast.error(safeMessage(reason))
        } finally {
          setBusy(false)
        }
      })
    },
    [refreshRepo]
  )

  const adoptAndOpen = useCallback(
    async (runtime: EnvironmentRecipeRuntime): Promise<void> => {
      if (runtime.status !== 'running' || runtime.connectionType !== 'ssh' || !runtime.adoption) {
        throw new Error('adoption_unavailable')
      }
      const adoption = runtime.adoption
      const project = catalog.projects.find((candidate) =>
        candidate.sourceRepoIds.includes(runtime.repoId)
      )
      if (!project) {
        throw new Error('project_unavailable')
      }
      const target = { kind: 'environment' as const, environmentId }
      const setupResult = await callRuntimeRpc<{ result: ProjectHostSetupResult }>(
        target,
        'projectHostSetup.setupExistingFolder',
        {
          projectId: project.id,
          hostId: adoption.executionHostId,
          path: adoption.expectedPath,
          displayName: runtime.workspaceName ?? project.displayName,
          setupMethod: 'imported-existing-folder'
        }
      )
      const result = await callRuntimeRpc<{ worktree: { id: string } }>(target, 'worktree.create', {
        repo: `id:${setupResult.result.repo.id}`,
        name: runtime.workspaceName ?? project.displayName,
        displayName: runtime.workspaceName ?? project.displayName,
        activate: true,
        clientMutationId: `environment-runtime-adopt:${runtime.runtimeId}`,
        provisionedRoot: {
          runtimeId: runtime.runtimeId,
          executionHostId: adoption.executionHostId,
          expectedPath: adoption.expectedPath
        }
      })
      useAppStore
        .getState()
        .setActiveWorktree(result.worktree.id, toRuntimeExecutionHostId(environmentId))
      useAppStore.getState().setActiveView('terminal')
    },
    [catalog.projects, environmentId]
  )

  useEffect(() => {
    const pending = supported ? loadDesktopEnvironmentRecipeMutation(environmentId) : null
    if (!pending || operationGateRef.current.isActive) {
      return
    }
    void runExclusive(async () => {
      const runtime = await provisionDesktopEnvironmentRecipe(environmentId, pending)
      await adoptAndOpen(runtime)
      clearDesktopEnvironmentRecipeMutation(environmentId)
    })
  }, [adoptAndOpen, environmentId, runExclusive, supported])

  const provision = (): void => {
    const recipe = recipes.find((candidate) => candidate.recipeId === recipeId)
    if (!recipe) {
      return
    }
    const entry = {
      repoId,
      recipeId,
      clientMutationId: crypto.randomUUID(),
      workspaceName: recipe.name
    }
    void runExclusive(async () => {
      saveDesktopEnvironmentRecipeMutation(environmentId, entry)
      const runtime = await provisionDesktopEnvironmentRecipe(environmentId, entry)
      await adoptAndOpen(runtime)
      clearDesktopEnvironmentRecipeMutation(environmentId)
    })
  }

  const mutate = (action: 'suspend' | 'resume' | 'destroy', runtime: EnvironmentRecipeRuntime) => {
    void runExclusive(async () => {
      const args = {
        repoId: runtime.repoId,
        recipeId: runtime.recipeId,
        runtimeId: runtime.runtimeId,
        clientMutationId: `${action}:${runtime.runtimeId}:${runtime.updatedAt}`
      }
      if (action === 'suspend') {
        await suspendDesktopEnvironmentRecipe(environmentId, args)
      }
      if (action === 'resume') {
        await resumeDesktopEnvironmentRecipe(environmentId, args)
      }
      if (action === 'destroy') {
        await destroyDesktopEnvironmentRecipe(environmentId, args)
      }
    })
  }

  const selectedRecipe = useMemo(
    () => recipes.find((recipe) => recipe.recipeId === recipeId),
    [recipeId, recipes]
  )

  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-card/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{copy.title}</div>
          <p className="text-xs text-muted-foreground">{copy.description}</p>
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={busy}
          onClick={() => void refreshCatalog()}
          aria-label={copy.refresh}
        >
          {supported === null ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>
      {supported === false ? (
        <p className="text-sm text-muted-foreground">{copy.updateRequired}</p>
      ) : null}
      {supported ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Select value={repoId} onValueChange={setRepoId} disabled={busy}>
              <SelectTrigger className="min-w-40">
                <SelectValue placeholder={copy.repository} />
              </SelectTrigger>
              <SelectContent>
                {catalog.repos.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repo.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={recipeId}
              onValueChange={setRecipeId}
              disabled={busy || recipes.length === 0}
            >
              <SelectTrigger className="min-w-40">
                <SelectValue placeholder={copy.eligibleRecipe} />
              </SelectTrigger>
              <SelectContent>
                {recipes.map((recipe) => (
                  <SelectItem key={recipe.recipeId} value={recipe.recipeId}>
                    {recipe.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button disabled={busy || !selectedRecipe} onClick={provision}>
              {busy ? <Loader2 className="animate-spin" /> : copy.provision}
            </Button>
          </div>
          <div className="divide-y divide-border/50 rounded-md border border-border/50">
            {runtimes.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{copy.none}</p>
            ) : (
              runtimes.map((runtime) => (
                <div key={runtime.runtimeId} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      {runtime.workspaceName ?? runtime.recipeId}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {runtime.status.replaceAll('_', ' ')}
                    </div>
                  </div>
                  {runtime.status === 'running' &&
                  runtime.connectionType === 'ssh' &&
                  runtime.adoption ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void runExclusive(() => adoptAndOpen(runtime))}
                    >
                      {copy.open}
                    </Button>
                  ) : null}
                  {runtime.status === 'running' && runtime.lifecycle.suspend ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => mutate('suspend', runtime)}
                    >
                      {copy.suspend}
                    </Button>
                  ) : null}
                  {runtime.status === 'suspended' && runtime.lifecycle.resume ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => mutate('resume', runtime)}
                    >
                      {copy.resume}
                    </Button>
                  ) : null}
                  {runtime.lifecycle.destroy ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setDestroyTarget(runtime)}
                    >
                      {copy.destroy}
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
      <Dialog
        open={destroyTarget !== null}
        onOpenChange={(open) => !open && setDestroyTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.destroyTitle}</DialogTitle>
            <DialogDescription>{copy.destroyDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{copy.cancel}</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (destroyTarget) {
                  mutate('destroy', destroyTarget)
                }
                setDestroyTarget(null)
              }}
            >
              {copy.destroy}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function safeMessage(reason: unknown): string {
  return reason instanceof EnvironmentRecipeClientError
    ? reason.message
    : 'Environment workspace operation failed on the runtime host.'
}
