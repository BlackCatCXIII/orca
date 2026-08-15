# Candidate artifacts

`Candidate Artifacts` is a manual, non-publishing build of source commit
`c887a8265cf9c9dfc4beba7c1ce2ea533907165f`. It is intended to produce the custom-fork
inputs needed before a separately authorized deployment without granting the build any
deployment authority.

The workflow-control commit intentionally sits above that runtime source. Lifecycle-envelope schema
provenance remains contract commit `f910c801aac823bb1b0768e79d1b3c865db295ac`; the runtime source
contains the later operator-catalog, replay, and durability implementation. Every platform checkout
continues to build exactly `c887a8265cf9c9dfc4beba7c1ce2ea533907165f`, never the control commit
that carries this pin.

## Safety boundary

The workflow has only `workflow_dispatch`, uses `contents: read`, disables persisted Git
credentials, reads no secrets, and pins every external action to a full commit SHA. It does
not create or push a tag, commit, release, registry image, store build, distribution signature,
or update feed. Every uploaded bundle expires after seven days and fails closed when an
expected file is missing.

The Android APK is signed only with Gradle's standard development debug key so Android can
install it for testing; it is not a distribution signature. The iOS output is an unsigned
Simulator `.app` archive and cannot be installed on a physical device. The macOS and Windows
packages are unsigned and may be blocked or warn when opened.

## Output bundles

Each platform bundle contains only the exact filenames declared in
`config/candidate-artifacts.json` plus `provenance.json`:

- Linux x64: `orca-hub-linux-x64.deb`, also usable as the desktop candidate. The `.deb` is the `orca-ide` package
  format defined by `config/electron-builder.config.cjs` for a later `images/orca-hub` image
  build.
- Linux arm64: an `orca-ide` `.deb` desktop candidate.
- Windows x64: an unsigned NSIS installer.
- macOS: unsigned x64 and arm64 DMG candidates.
- Android: an Expo/Gradle debug APK.
- iOS: an unsigned Xcode Simulator application archive.

The provenance file records the pinned source revision, workflow revision, SHA-256 hashes of
both pnpm lockfiles, exact artifact byte sizes and SHA-256 hashes, installability, signing
state, and the fact that nothing was published or emitted as update metadata. Its content is
deterministic for the same workflow revision and artifact bytes; it intentionally contains no
clock time or runner-generated identifier.

These artifacts prove that pinned source and pinned dependency graphs completed the repository's
native packaging commands on the named CI platform, and bind the resulting bytes to checksums.
GitHub-hosted runner labels and their installed toolchains are mutable, so this provenance is a
source/lockfile/artifact checksum binding, not a claim of byte-for-byte reproducibility across
runner image updates.
They do not prove release approval, identity, notarization, malware review, production
configuration, compatibility with every target host, or authorization to deploy.

## Distribution is a separate authorized operation

Do not treat a successful candidate run as distribution approval. Later release owners need
all normal review gates plus credentials held outside this workflow:

- macOS distribution requires a Developer ID Application certificate/private key, certificate
  password, Apple notarization credentials, and Team ID, plus authorization to publish the
  notarized result.
- Windows distribution requires the approved SignPath organization/project/policy and API
  authorization, or an equivalent protected Authenticode certificate service, plus release
  publication authority.
- Physical-device or TestFlight iOS distribution requires an Apple Distribution certificate
  and private key, provisioning access, App Store Connect API key/issuer/key material, Team ID,
  and explicit App Store Connect upload/distribution authorization.
- Hub deployment requires separate image-build and registry credentials. This workflow only
  supplies the unsigned `.deb`; it never builds or pushes `images/orca-hub`.

## Validation

Run the targeted checks from the repository root:

```sh
pnpm exec vitest run --config config/vitest.config.ts config/scripts/candidate-artifact-workflow-policy.test.mjs
pnpm exec vitest run --config config/vitest.config.ts config/scripts/candidate-artifact-policy.test.mjs
node config/scripts/candidate-artifact-workflow-policy.mjs
actionlint .github/workflows/candidate-artifacts.yml
pnpm exec oxfmt --check config/candidate-artifacts.json config/electron-builder-candidate.config.cjs config/scripts/candidate-artifact-policy.mjs config/scripts/candidate-artifact-policy.test.mjs config/scripts/candidate-artifact-provenance.mjs config/scripts/candidate-artifact-workflow-policy.mjs config/scripts/candidate-artifact-workflow-policy.test.mjs .github/CANDIDATE_ARTIFACTS.md
```

The adversarial tests reject push, pull-request, or schedule triggers; mutable action refs;
write permissions; publishing or signing commands; secret access; unbounded uploads; missing
provenance validation; extra artifacts; and missing provenance fields.
Policy validation also rejects unknown fields or platforms, path traversal, symlinked source
lockfiles, and non-file artifact entries.

Context7 documentation lookup was attempted for GitHub Actions and Expo while implementing
this workflow, as required by repository policy. Both resolutions failed with `Invalid or
expired OAuth token`; no web fallback was used, so the implementation relies only on the pinned
desktop/mobile workflows, package scripts, lockfiles, and Electron Builder configuration in
this repository.
