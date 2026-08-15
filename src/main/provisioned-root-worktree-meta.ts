import { randomUUID } from 'node:crypto'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type { AdoptProvisionedRootArgs } from '../shared/worktree/create-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import type { AutomationWorkspaceProvenance } from '../shared/worktree/types'
import { getProjectHostSetupWorktreeMeta } from '../shared/project-host-setup-projection'
import { isTuiAgent } from '../shared/tui-agent-config'
import { getWorktreeCreationLayout } from './ipc/worktree-logic'

type ProvisionedRootMetaArgs = AdoptProvisionedRootArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
}

export function buildProvisionedRootMeta(
  store: Pick<Store, 'getProjectHostSetups' | 'getSettings'>,
  repo: Repo,
  args: ProvisionedRootMetaArgs,
  now: number,
  existing?: WorktreeMeta
): Partial<WorktreeMeta> {
  return {
    instanceId: existing?.instanceId ?? randomUUID(),
    ...getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo),
    hostId: args.executionHostId,
    ephemeralVmCheckoutMode: 'provisioned-root',
    displayName: args.displayName || args.name,
    lastActivityAt: existing?.lastActivityAt ?? now,
    createdAt: existing?.createdAt ?? now,
    orcaCreatedAt: existing?.orcaCreatedAt ?? now,
    orcaCreationSource: 'ssh',
    creatorProvenance: { kind: 'host' },
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, store.getSettings()),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.compareBaseRef || args.baseBranch
      ? { baseRef: args.compareBaseRef ?? args.baseBranch }
      : {}),
    ...(args.pushTarget ? { pushTarget: args.pushTarget } : {}),
    ...(isTuiAgent(args.createdWithAgent) ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.pendingFirstAgentMessageRename === true && isTuiAgent(args.createdWithAgent)
      ? { pendingFirstAgentMessageRename: true }
      : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedBitbucketPR !== undefined ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
      : {}),
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {})
  }
}
