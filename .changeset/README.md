# Release workflow

Main accumulates changesets. A `release/<cycle>` branch freezes the candidate source and maintains a `ci: release packages` PR with head `changeset-release/release/<cycle>`. Use the `gen-changesets` skill for user-facing entries; the actual package manifests determine which changed packages publish to npm. Private packages may receive version updates but are never published.

## Prepare and approve

1. Create the release branch from the selected commit. Backport fixes individually; do not merge later main changes into the candidate. Changes to the embedded web assets must be synced from the corresponding code-app candidate and reviewed on this release branch.
2. Release push maintains the version PR. Manual **Release** runs only prepare/refresh it; they never publish. The version command records package versions and consumed changesets in `.changeset/release-plan.json`.
3. The workflow explicitly dispatches CI on the generated version branch because `GITHUB_TOKEN` pushes do not trigger normal PR checks. Present the latest version PR, CI result/link and pre-changelog for approval. Test native binaries with **Manual Native Bundle** before publishing.
4. A maintainer merges the approved version PR. Its merge commit is fixed for the entire release. The release workflow identifies the merged PR by source/target repository and branch plus merge SHA, waits for that commit's push CI, and verifies the version plan. Failed or cancelled CI stops publication. Later release pushes do not cancel this CI.

## Automatic publication

- Reserve package tags at the approved SHA and create the primary draft GitHub Release. A tag on a different commit is an error.
- Generate the built-in catalog once, build packages and pack the changed public npm packages with pnpm. Save the exact tarballs, catalog, package plan and source SHA in `release-inputs.tar.gz` on the draft Release before any npm publish.
- Check npm registry integrity for each planned package/version. Skip only matching tarballs; publish missing versions using npm Trusted Publishing. Authentication/network failures and conflicting contents stop the run. Never roll npm `latest` back behind a newer stable version.
- If the CLI is in the plan, build all six signed native targets from the same SHA and saved catalog. Validate archive checksums, six-platform completeness and the native manifest before uploading to the draft Release.
- Save a completion record, verify uploaded asset digests, create/update package release notes and expose the primary Release last. Completed public releases are verified, never overwritten. SDK-only public plans do not require CLI binaries; private-only plans do not publish.
- CDN upload, `latest` / `latest.json` routing and announcements remain separately approved operations. No workflow in this process changes CDN routing.

## Recover an interrupted release

Use **Re-run failed jobs** on the original Release run when its artifacts are available. If artifacts expired or a wider retry is needed, use **Re-run all jobs** on that same run. Do not dispatch a new run from the moving branch tip.

| Failure | Recovery |
| --- | --- |
| Some npm packages published | Restore saved tarballs, verify registry integrity and publish only missing packages |
| npm succeeded, a native target failed | Restore the same catalog and retry native builds; npm publication is not the gate for native builds |
| Upload interrupted | Complete uploads while the Release is still a draft; publish only after all checks pass |
| Actions artifacts expired | Rebuild from the original SHA and saved Release inputs |
| Complete Release retried | Verify its completion record and asset digests; do not upload or publish again |
| Saved inputs missing/corrupt, tag moved or registry contents conflict | Stop for investigation; never silently regenerate replacement npm contents |

Signed/recompressed native output need not be byte-identical when rebuilt. Draft assets may be replaced while recovering; completed public assets may not. Do not delete `release-inputs.tar.gz` or `release-complete.json`: recovery depends on them. Preserve draft Releases after failure.

## Migration and synchronization

- Merge the main workflow change first to disable the legacy main npm publisher, then the matching release workflow change. These infrastructure PRs do not publish. Review and close the obsolete main version PR separately; do not retarget it or merge it for this cycle.
- Once both changes are installed, refresh the release version PR and check its CI before approval. Only maintain one active npm release cycle at a time. npm publishes are serialized, but maintainers must not approve competing release cycles with conflicting versions.
- After publishing, open a synchronization PR carrying version/lockfile changes, changelogs, the release plan and consumed changeset removals back to main. Preserve newer main changesets and fixes. Do not move the Desktop submodule pointer as part of this operation.
- Main pushes never publish npm. Main docs changes or release-plan synchronization deploy documentation; release branches do not deploy Pages.
- VSCode version synchronization matching `release-plan.json` skips automatic marketplace publication. Publish the extension separately using its existing manual workflow if desired. Independent main version changes retain their existing behavior.

## Credentials and checks

Each public npm package must trust `MoonshotAI/kimi-code`, workflow `release.yml`, with no environment restriction. The workflow retains `id-token: write` and npm 11; no npm token is added. Repository Pages deployment and signing credentials keep their existing configuration. Live OIDC publishing and signing require a separately approved release; mocked tests do not validate those credentials.

Run `node --test scripts/core-release.test.mjs scripts/release-trigger.test.mjs`. Native archive tests live in `apps/kimi-code/test/scripts/native/release-artifacts.test.ts`.
