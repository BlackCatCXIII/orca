import * as ExpoCrypto from 'expo-crypto'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import type {
  EnvironmentRecipeDescriptor,
  EnvironmentRecipeRuntime
} from '../../../../src/shared/environment-recipe-runtime-rpc'
import { EnvironmentRecipeOperationGate } from '../../../../src/shared/environment-recipe-operation-gate'
import { ConfirmModal } from '../../../src/components/ConfirmModal'
import { PickerModal } from '../../../src/components/PickerModal'
import { useHostClient } from '../../../src/transport/client-context'
import { colors } from '../../../src/theme/mobile-theme'
import {
  destroyMobileEnvironmentRecipe,
  listMobileEnvironmentRecipeRuntimes,
  listMobileEnvironmentRecipes,
  provisionMobileEnvironmentRecipe,
  resumeMobileEnvironmentRecipe,
  supportsEnvironmentRecipeLifecycle,
  suspendMobileEnvironmentRecipe
} from '../../../src/environment-recipes/environment-recipe-client'
import {
  clearEnvironmentRecipeMutation,
  loadEnvironmentRecipeMutation,
  saveEnvironmentRecipeMutation
} from '../../../src/environment-recipes/environment-recipe-mutation-journal'
import { styles } from '../../../src/environment-recipes/environment-workspaces-screen-styles'
import {
  adoptMobileEnvironmentWorkspace,
  loadMobileEnvironmentRecipeCapabilities,
  loadMobileEnvironmentRecipeCatalog,
  safeEnvironmentWorkspaceMessage,
  type MobileEnvironmentRecipeCatalog
} from '../../../src/environment-recipes/environment-workspace-adoption'

export default function EnvironmentWorkspacesScreen() {
  const router = useRouter()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const { client, state } = useHostClient(hostId)
  const operationGateRef = useRef(new EnvironmentRecipeOperationGate())
  const [capabilities, setCapabilities] = useState<readonly string[]>([])
  const [catalog, setCatalog] = useState<MobileEnvironmentRecipeCatalog>({
    repos: [],
    projects: []
  })
  const [repoId, setRepoId] = useState('')
  const [recipes, setRecipes] = useState<EnvironmentRecipeDescriptor[]>([])
  const [runtimes, setRuntimes] = useState<EnvironmentRecipeRuntime[]>([])
  const [recipeId, setRecipeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [recipePickerOpen, setRecipePickerOpen] = useState(false)
  const [destroyTarget, setDestroyTarget] = useState<EnvironmentRecipeRuntime | null>(null)

  const supported = supportsEnvironmentRecipeLifecycle(capabilities)
  const selectedRepo = catalog.repos.find((repo) => repo.id === repoId)
  const selectedRecipe = recipes.find((recipe) => recipe.recipeId === recipeId)

  const refresh = async (): Promise<void> => {
    if (!client || state !== 'connected') {
      return
    }
    setLoading(true)
    setError('')
    try {
      const nextCapabilities = await loadMobileEnvironmentRecipeCapabilities(client)
      setCapabilities(nextCapabilities)
      if (!supportsEnvironmentRecipeLifecycle(nextCapabilities)) {
        return
      }
      const nextCatalog = await loadMobileEnvironmentRecipeCatalog(client)
      setCatalog(nextCatalog)
      setRepoId((current) =>
        nextCatalog.repos.some((repo) => repo.id === current)
          ? current
          : (nextCatalog.repos[0]?.id ?? '')
      )
    } catch {
      setError('Could not load environment workspaces from this host.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [client, state])

  useEffect(() => {
    if (!client || !supported || !repoId) {
      setRecipes([])
      setRuntimes([])
      return
    }
    let stale = false
    setLoading(true)
    Promise.all([
      listMobileEnvironmentRecipes(client, capabilities, repoId),
      listMobileEnvironmentRecipeRuntimes(client, capabilities, repoId)
    ])
      .then(([recipeResult, runtimeResult]) => {
        if (stale) {
          return
        }
        const eligible = recipeResult.recipes.filter(
          (recipe) => recipe.checkoutMode === 'provisioned-root'
        )
        setRecipes(eligible)
        setRuntimes(runtimeResult.runtimes.filter((runtime) => runtime.status !== 'cleaned'))
        setRecipeId((current) =>
          eligible.some((recipe) => recipe.recipeId === current)
            ? current
            : (eligible[0]?.recipeId ?? '')
        )
        setError('')
      })
      .catch((reason) => !stale && setError(safeEnvironmentWorkspaceMessage(reason)))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [capabilities, client, repoId, supported])

  useEffect(() => {
    if (!client || !supported || !hostId || operationGateRef.current.isActive) {
      return
    }
    void loadEnvironmentRecipeMutation(hostId).then((pending) => {
      if (!pending || operationGateRef.current.isActive) {
        return
      }
      void runExclusive(async () => {
        const runtime = await provisionMobileEnvironmentRecipe(client, capabilities, pending)
        await adoptAndOpen(runtime)
        await clearEnvironmentRecipeMutation(hostId)
      })
    })
  }, [capabilities, catalog.projects, client, hostId, supported])

  const runExclusive = async (operation: () => Promise<void>): Promise<void> => {
    await operationGateRef.current.run(async () => {
      setBusy(true)
      setError('')
      try {
        await operation()
        if (client && repoId) {
          const result = await listMobileEnvironmentRecipeRuntimes(client, capabilities, repoId)
          setRuntimes(result.runtimes.filter((runtime) => runtime.status !== 'cleaned'))
        }
      } catch (reason) {
        setError(safeEnvironmentWorkspaceMessage(reason))
      } finally {
        setBusy(false)
      }
    })
  }

  const provision = (): void => {
    if (!client || !hostId || !selectedRecipe || !selectedRepo) {
      return
    }
    const entry = {
      repoId: selectedRepo.id,
      recipeId: selectedRecipe.recipeId,
      clientMutationId: ExpoCrypto.randomUUID(),
      workspaceName: selectedRecipe.name
    }
    void runExclusive(async () => {
      await saveEnvironmentRecipeMutation(hostId, entry)
      const runtime = await provisionMobileEnvironmentRecipe(client, capabilities, entry)
      await adoptAndOpen(runtime)
      await clearEnvironmentRecipeMutation(hostId)
    })
  }

  const mutate = (action: 'suspend' | 'resume' | 'destroy', runtime: EnvironmentRecipeRuntime) => {
    if (!client) {
      return
    }
    void runExclusive(async () => {
      const args = {
        repoId: runtime.repoId,
        recipeId: runtime.recipeId,
        runtimeId: runtime.runtimeId,
        clientMutationId: `${action}:${runtime.runtimeId}:${runtime.updatedAt}`
      }
      if (action === 'suspend') {
        await suspendMobileEnvironmentRecipe(client, capabilities, args)
      }
      if (action === 'resume') {
        await resumeMobileEnvironmentRecipe(client, capabilities, args)
      }
      if (action === 'destroy') {
        await destroyMobileEnvironmentRecipe(client, capabilities, args)
      }
    })
  }

  const repoOptions = useMemo(
    () => catalog.repos.map((repo) => ({ value: repo.id, label: repo.displayName })),
    [catalog.repos]
  )
  const recipeOptions = useMemo(
    () => recipes.map((recipe) => ({ value: recipe.recipeId, label: recipe.name })),
    [recipes]
  )

  const adoptAndOpen = async (runtime: EnvironmentRecipeRuntime): Promise<void> => {
    if (!client) {
      return
    }
    const worktree = await adoptMobileEnvironmentWorkspace(client, runtime, catalog.projects)
    router.push(
      `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktree.id)}?name=${encodeURIComponent(worktree.name)}`
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={() => router.back()} accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <Text style={styles.title}>Environment workspaces</Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        {!supported && !loading ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Host update required</Text>
            <Text style={styles.body}>
              Update Orca on this host to manage environment workspaces remotely.
            </Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {supported ? (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>New environment workspace</Text>
              <PickerButton
                label={selectedRepo?.displayName ?? 'Choose repository'}
                disabled={busy}
                onPress={() => setRepoPickerOpen(true)}
              />
              <PickerButton
                label={selectedRecipe?.name ?? 'No eligible recipe'}
                disabled={busy || !selectedRecipe}
                onPress={() => setRecipePickerOpen(true)}
              />
              <Pressable
                style={[
                  styles.button,
                  styles.primaryButton,
                  (busy || !selectedRecipe) && styles.disabled
                ]}
                disabled={busy || !selectedRecipe}
                onPress={provision}
              >
                {busy ? (
                  <ActivityIndicator color={colors.bgBase} />
                ) : (
                  <Text style={styles.primaryButtonText}>Provision and open</Text>
                )}
              </Pressable>
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Managed workspaces</Text>
              {runtimes.length === 0 ? (
                <Text style={styles.body}>No managed workspaces yet.</Text>
              ) : null}
              {runtimes.map((runtime, index) => (
                <RuntimeRow
                  key={runtime.runtimeId}
                  runtime={runtime}
                  bordered={index > 0}
                  disabled={busy}
                  onOpen={() => client && void runExclusive(() => adoptAndOpen(runtime))}
                  onSuspend={() => mutate('suspend', runtime)}
                  onResume={() => mutate('resume', runtime)}
                  onDestroy={() => setDestroyTarget(runtime)}
                />
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
      <PickerModal
        visible={repoPickerOpen}
        title="Repository"
        options={repoOptions}
        selected={repoId}
        onSelect={setRepoId}
        onClose={() => setRepoPickerOpen(false)}
      />
      <PickerModal
        visible={recipePickerOpen}
        title="Recipe"
        options={recipeOptions}
        selected={recipeId}
        onSelect={setRecipeId}
        onClose={() => setRecipePickerOpen(false)}
      />
      <ConfirmModal
        visible={destroyTarget !== null}
        title="Destroy environment workspace?"
        message="This permanently destroys the provider workspace."
        confirmLabel="Destroy"
        destructive
        onCancel={() => setDestroyTarget(null)}
        onConfirm={() => destroyTarget && mutate('destroy', destroyTarget)}
      />
    </SafeAreaView>
  )
}

function PickerButton({
  label,
  disabled,
  onPress
}: {
  label: string
  disabled: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      style={[styles.button, disabled && styles.disabled]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

function RuntimeRow(props: {
  runtime: EnvironmentRecipeRuntime
  bordered: boolean
  disabled: boolean
  onOpen: () => void
  onSuspend: () => void
  onResume: () => void
  onDestroy: () => void
}) {
  const { runtime } = props
  return (
    <View style={[styles.row, props.bordered && styles.rowBorder]}>
      <Text style={styles.body}>{runtime.workspaceName ?? runtime.recipeId}</Text>
      <Text style={styles.meta}>{runtime.status.replaceAll('_', ' ')}</Text>
      <View style={styles.actions}>
        {runtime.status === 'running' && runtime.connectionType === 'ssh' && runtime.adoption ? (
          <Action label="Open" disabled={props.disabled} onPress={props.onOpen} />
        ) : null}
        {runtime.status === 'running' && runtime.lifecycle.suspend ? (
          <Action label="Suspend" disabled={props.disabled} onPress={props.onSuspend} />
        ) : null}
        {runtime.status === 'suspended' && runtime.lifecycle.resume ? (
          <Action label="Resume" disabled={props.disabled} onPress={props.onResume} />
        ) : null}
        {runtime.lifecycle.destroy ? (
          <Action label="Destroy" disabled={props.disabled} onPress={props.onDestroy} destructive />
        ) : null}
      </View>
    </View>
  )
}

function Action({
  label,
  disabled,
  onPress,
  destructive
}: {
  label: string
  disabled: boolean
  onPress: () => void
  destructive?: boolean
}) {
  return (
    <Pressable
      style={[styles.button, disabled && styles.disabled]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={[styles.buttonText, destructive && styles.destructiveText]}>{label}</Text>
    </Pressable>
  )
}
