# Downstream upstream-sync merge train

The daily readiness workflow answers one question without changing the fork: can the exact
downstream commit merge the exact commit currently advertised by `stablyai/orca` `main`? It
uses a disposable repository, retains JSON and Markdown evidence in private MinIO, and fails when
the refs move, history is incomplete, or the simulated merge conflicts.

The workflow runs only on the exact `orca-source-ci` ARC label. It uses no GitHub-hosted runner,
GitHub artifact storage, or GitHub dependency cache. The report key contains the full downstream
SHA, workflow digest, run ID, run attempt, and content SHA; curl SigV4 uploads are non-overwriting,
and every retained object must pass a digest-verified readback before the workflow can succeed.

The workflow is intentionally read-only. It cannot push, open or update pull requests or issues,
publish releases, deploy, or read repository secrets. Its credential-free checkout and public
fetches mean the scheduled lane only works while the downstream repository is publicly readable.
It only reports merge readiness; it never creates a merge commit or advances a branch.

## Human-reviewed merge procedure

1. Record the downstream tip, the advertised upstream SHA, and the readiness report. Fetch the
   official `stablyai/orca` `main` without changing a deployment pin.
2. Create a dated integration branch from the recorded downstream tip. Merge the recorded upstream
   SHA with `--no-ff`; do not rebase or replay the downstream stack. The merge commit preserves an
   auditable boundary for the next daily comparison.
3. Resolve every conflict semantically. Compare both parents, preserve upstream bug fixes, and
   reapply only the downstream invariant that still exists. Treat runtime, protocol, persistence,
   worktree, mobile, and remote/SSH hotspots as code-review boundaries rather than choosing a side
   mechanically.
4. Run focused tests for every conflicted or overlapping subsystem first. Then run the normal full
   gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Record the exact commands,
   results, merge commit, both parent SHAs, and any deliberate deviations.
5. Have a second reviewer inspect the merge commit and evidence. Publish the integration branch only
   through the normal reviewed path. Do not let the reporting workflow mutate or publish it.
6. Advance the deployment's immutable Orca source/image pin only after the merge commit has passed
   the focused and full gates and the corresponding immutable artifact digest has been verified.
   Keep the prior pin available for rollback.

## Upstream submission is a separate track

This merge train keeps the downstream integration current; it does not make the roughly 169-file,
15,000-line product delta suitable for one upstream pull request. Extract reviewable, dependency-
ordered submissions instead:

1. Core schema plus SSH and lifecycle primitives.
2. Headless catalog and provisioning UI, based on the accepted core.
3. Durable repository and replay state, based on the accepted lifecycle contracts.

Candidate-artifact machinery, this daily-sync policy, and deployment-specific controls remain
downstream-only. Preparing this stack does not authorize publishing branches or opening requests.

## Local report

Run from a clean, complete checkout. Use full branch refs or immutable 40-character lowercase SHAs;
ambiguous names such as `main` and tag refs are rejected.

```bash
node config/scripts/upstream-sync-report.mjs \
  --repo . \
  --downstream-ref refs/heads/your-integration-branch \
  --downstream-url https://github.com/your-org/orca.git \
  --upstream-ref refs/heads/main \
  --upstream-url https://github.com/stablyai/orca.git \
  --json artifacts/upstream-sync/report.json \
  --markdown artifacts/upstream-sync/report.md
```

The command exits `0` for a clean simulation, `3` for reported conflicts, and `2` for invalid or
incomplete evidence. Both report formats contain exact SHAs, ahead/behind counts, conflict paths,
and categorized overlap hotspots. The caller worktree is never used for the merge. Disposable Git
commands discard inherited Git command configuration, object/worktree overrides, credential and
askpass controls, and hooks.

Each repository URL/path must be able to serve complete Git objects. A local shallow or blob-filtered
promisor clone may be unable to re-export missing objects; use its complete hosted URL or a full local
clone instead. The tool uses only Node and baseline Git commands and avoids shell-specific syntax,
but maintainers should keep the scheduled Linux run and focused tests green when changing it on
macOS or Windows.
