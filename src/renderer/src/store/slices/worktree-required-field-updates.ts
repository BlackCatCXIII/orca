import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Worktree } from '../../../../shared/worktree/types'

type RequiredKey<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T]

// Why: present undefined values clear optional metadata, but must never erase required worktree fields.
const ERASURE_PROTECTED_KEYS: Record<Extract<RequiredKey<Worktree>, keyof WorktreeMeta>, true> = {
  displayName: true,
  comment: true,
  linkedIssue: true,
  linkedPR: true,
  linkedLinearIssue: true,
  isArchived: true,
  isUnread: true,
  isPinned: true,
  sortOrder: true,
  lastActivityAt: true
}

export function withoutErasedRequiredWorktreeFields(
  updates: Partial<WorktreeMeta>
): Partial<WorktreeMeta> {
  const erased = Object.keys(ERASURE_PROTECTED_KEYS).filter(
    (key) => updates[key as keyof WorktreeMeta] === undefined && Object.hasOwn(updates, key)
  )
  if (erased.length === 0) {
    return updates
  }

  const next = { ...updates }
  for (const key of erased) {
    delete next[key as keyof WorktreeMeta]
  }
  return next
}
