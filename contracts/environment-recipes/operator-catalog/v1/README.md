# Headless operator environment-recipe catalog v1

Start the packaged runtime with both `--operator-recipe-catalog <absolute JSON>` and `--operator-recipe-catalog-sha256 <64 lowercase hex>`, plus `--no-pairing`. Operator mode rejects mobile pairing, recipe JSON, and project-root flags; existing authenticated runtime-scoped devices may call `environmentRecipes.*`.

Every recipe is `provisioned-root`. Each lifecycle phase names one safe relative executable file and binds its exact bytes with SHA-256. IDs and script paths are unique across the catalog, UTF-8 must decode without replacement, JSON object keys may not repeat, and input may contain at most 16 nested object/array containers. Runtime validation additionally rejects dot traversal, backslashes, control characters, symlinks, hard links, non-files, non-executable scripts, oversized files, and any catalog/script ancestry that is not root-owned or is group/other writable. Catalog and script reads bind `lstat`, no-follow `open`, descriptor `fstat`, bounded descriptor bytes, and a final stable path identity before each recipe lookup.

The RPC `repoId` always selects the actual target repository. Its path, sanitized Git remote, branch, ref, project, and workspace context still flow to the operator executable; the catalog directory is never registered or substituted as a repository. Target `orca.yaml` and plugin recipes do not participate in operator mode.

An explicit provision `ref` is preserved. When it is absent, the server resolves the selected local Git target's `HEAD^{commit}` once through Orca's repository Git runner and passes that full object ID; an unborn, missing, ambiguous, or non-commit HEAD fails before recipe execution, and no branch or remote default is synthesized.

Each created runtime persists the exact operator catalog SHA-256. Listing and lifecycle calls require the currently verified catalog to have that same identity and use descriptor-verified direct execution; without it, operator runtimes are hidden and denied by remote and local desktop lifecycle entrypoints.

Provisioned-root SSH host-key pins remain on the in-process SSH transport where the negotiated key is verified. A pinned target that requires system OpenSSH fails closed; force-system, proxy/config, security-key, GSSAPI, and reactive system fallbacks cannot bypass the pin.

`schema.json` is the canonical contract and `schema.lock.json` binds its exact bytes. Uniqueness and filesystem rules that JSON Schema cannot express remain mandatory runtime checks.

The candidate artifact workflow and lifecycle envelope contract remain intentionally pinned to runtime source `338bd227c12067ace0661d95f66ae4ecb5223a68`. This support branch integrates lifecycle contract commit `f910c801aac823bb1b0768e79d1b3c865db295ac` without changing those schema bytes; it does not retarget the candidate build.

Context7 lookup was attempted before this work and failed with `Invalid or expired OAuth token`. Per the task boundary, no retry or web fallback was used; implementation relied on pinned local Orca source.
