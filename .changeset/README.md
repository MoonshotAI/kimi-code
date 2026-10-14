# Release workflow

Main accumulates changesets. A `release/<cycle>` branch freezes the candidate source and maintains a `ci: release packages` PR with head `changeset-release/release/<cycle>`. Use the `gen-changesets` skill for user-facing entries; this workflow publishes only `@moonshot-ai/kimi-code`. The plan must include a CLI version change. Private packages may receive version updates but are never published to npm; other public package plans are rejected.

## Prepare and approve

1. Create the release branch from the selected commit. Backport fixes individually; do not merge later main changes into the candidate. Changes to the embedded web assets must be synced from the corresponding code-app candidate and reviewed on this release branch.
2. Release push maintains the version PR. Manual **Release** runs only prepare/refresh it; they never publish. The version command records package versions and consumed changesets in `.changeset/release-plan.json`.
3. The workflow explicitly dispatches CI on the generated version branch because `GITHUB_TOKEN` pushes do not trigger normal PR checks. Present the latest version PR, CI result/link and pre-changelog for approval. Test native binaries with **Manual Native Bundle** before publishing.
4. A maintainer merges the approved version PR. Its merge commit is fixed for the entire release. The release workflow identifies the merged PR by source/target repository and branch plus merge SHA, waits for that commit's push CI, and verifies the version plan. Failed or cancelled CI stops publication. Later release pushes do not cancel this CI.

## Automatic publication

- Reserve the CLI tag at the approved SHA and create the draft GitHub Release. A tag on a different commit is an error.
- Generate the built-in catalog once, build packages and pack the CLI npm package with pnpm. Save the exact tarballs, catalog, package plan and source SHA in `release-inputs.tar.gz` on the draft Release before any npm publish.
- Check npm registry integrity for the planned CLI version. Skip only matching tarballs; publish missing versions using npm Trusted Publishing. Authentication/network failures and conflicting contents stop the run. Never roll npm `latest` back behind a newer stable version.
- Build all six signed native targets from the same SHA and saved catalog. Validate archive checksums, six-platform completeness and the native manifest before uploading to the draft Release.
- After all uploads succeed, update CLI release notes and publish the draft Release. Already-public Releases are skipped without rechecking or overwriting their assets. Do not manually publish an incomplete draft.
- CDN upload, `latest` / `latest.json` routing and announcements remain separately approved operations. No workflow in this process changes CDN routing.

## Recover an interrupted release

Use **Re-run failed jobs** on the original Release run when its artifacts are available. If artifacts expired or a wider retry is needed, use **Re-run all jobs** on that same run. Do not dispatch a new run from the moving branch tip.

| Failure | Recovery |
| --- | --- |
| npm publish returned an error after accepting the version | Restore the saved tarball, verify registry integrity and skip the matching published version |
| npm succeeded, a native target failed | Restore the same catalog and retry native builds; npm publication is not the gate for native builds |
| Upload interrupted | Complete uploads while the Release is still a draft; publish only after all checks pass |
| Actions artifacts expired | Rebuild from the original SHA and saved Release inputs |
| Complete Release retried | Skip it; do not download, upload or publish again |
| Saved inputs missing/corrupt, tag moved or registry contents conflict | Stop for investigation; never silently regenerate replacement npm contents |

Signed/recompressed native output need not be byte-identical when rebuilt. Draft assets may be replaced while recovering; completed public assets may not. Do not delete `release-inputs.tar.gz`: interrupted-release recovery depends on it. Preserve draft Releases after failure.

## Migration and synchronization

- Merge the main workflow change first to disable the legacy main npm publisher, then the matching release workflow change. These infrastructure PRs do not publish. Review and close the obsolete main version PR separately; do not retarget it or merge it for this cycle.
- Once both changes are installed, refresh the release version PR and check its CI before approval. Only maintain one active npm release cycle at a time. npm publishes are serialized, but maintainers must not approve competing release cycles with conflicting versions.
- After publishing, open a synchronization PR carrying version/lockfile changes, changelogs, the release plan and consumed changeset removals back to main. Preserve newer main changesets and fixes. Do not move the Desktop submodule pointer as part of this operation.
- Main pushes never publish npm. After CLI release completion, dispatch the existing docs workflow on main; Pages keeps its existing main-only deployment restriction. Failed docs deployment can be retried independently.
- VS Code publishes from the same approved release commit, independently of CLI/npm/native success. The reusable extension workflow runs only when `apps/vscode` is in that commit's release plan with a matching version. Main synchronization never publishes an extension. Approve the extension version and notes together with the CLI version PR. Retry failed extension jobs on the original Release run; its existing marketplace checks supplement missing platforms. The standalone manual extension publisher is removed to avoid bypassing the release approval and CI gate.

## Credentials and checks

The CLI npm package must trust `MoonshotAI/kimi-code`, workflow `release.yml`, with no environment restriction. The workflow retains `id-token: write` and npm 11; no npm token is added. Repository Pages deployment and signing credentials keep their existing configuration. Live OIDC publishing and signing require a separately approved release; mocked tests do not validate those credentials.

Run `node --test scripts/core-release.test.mjs scripts/release-trigger.test.mjs`. Native archive tests live in `apps/kimi-code/test/scripts/native/release-artifacts.test.ts`.
