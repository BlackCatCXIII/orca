import { translate } from '@/i18n/i18n'

export function getRemoteEnvironmentWorkspacesCopy() {
  return {
    loadError: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.loadError',
      'Could not load environment workspaces from this host.'
    ),
    title: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.title',
      'Remote environment workspaces'
    ),
    description: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.description',
      'Provision and manage recipe-backed SSH workspaces on the paired host.'
    ),
    refresh: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.refresh',
      'Refresh remote environment workspaces'
    ),
    updateRequired: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.updateRequired',
      'Update Orca on this host to manage environment workspaces remotely.'
    ),
    repository: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.repository',
      'Repository'
    ),
    eligibleRecipe: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.eligibleRecipe',
      'Eligible recipe'
    ),
    provision: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.provision',
      'Provision and open'
    ),
    none: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.none',
      'No managed workspaces yet.'
    ),
    open: translate('auto.components.settings.RemoteEnvironmentWorkspacesSection.open', 'Open'),
    suspend: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.suspend',
      'Suspend'
    ),
    resume: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.resume',
      'Resume'
    ),
    destroy: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.destroy',
      'Destroy'
    ),
    destroyTitle: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.destroyTitle',
      'Destroy environment workspace?'
    ),
    destroyDescription: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.destroyDescription',
      'This permanently destroys the provider workspace.'
    ),
    cancel: translate(
      'auto.components.settings.RemoteEnvironmentWorkspacesSection.cancel',
      'Cancel'
    )
  } as const
}
