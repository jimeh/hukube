# Desktop releases and updates

Hukube releases the UI, desktop Host, and bundled Go Engine together. The first
release is `v0.1.0`. This setup PR does not publish it: Release Please must open
a subsequent version PR, and that PR must be reviewed and merged separately.
No release workflow runs on a draft-release event.

## Configure the repository before the first release

1. In **Settings > General > Releases**, enable **Release immutability**.
   Immutability applies to future publications. The publisher checks the setting
   before publishing, then verifies the resulting immutable release and its
   GitHub release attestation.
2. Install a GitHub App on **jimeh/hukube only**. It needs repository Contents
   **read/write**, Issues **read/write**, Pull requests **read/write**, and
   Administration **read-only**. Metadata read access is implicit. The first
   three permissions let Release Please maintain its version PR, labels, draft,
   and explicit tag. Administration read access lets the final job verify the
   release immutability setting. No Administration write permission is needed.
   The installation token lets the version PR trigger normal CI checks.
3. Add the following repository Actions Secrets and Variables. These workflows
   use repository scope and do not select a protected GitHub Environment.
   Organization-level values must explicitly allow this repository. If moving
   signing to a protected Environment, declare it on the signing job and resolve
   its secrets there. Environment secrets are not passed from a caller through
   `workflow_call`.

| Kind     | Name                      | Exact value and use                                                                                                                                                               |
| -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret   | `RELEASE_BOT_PRIVATE_KEY` | The GitHub App's complete PEM private key, including BEGIN/END lines and real newlines. Do not base64 encode it. Used by the pinned GitHub App token action.                      |
| Variable | `RELEASE_BOT_CLIENT_ID`   | The App's Client ID, such as `Iv23...`, not an installation ID or a token. An unset value leaves Release Please inactive.                                                         |
| Secret   | `MACOS_SIGN_P12`          | Base64 of an exported **Developer ID Application** PKCS#12 file containing the certificate and its private key. It is not a Developer ID Installer or Apple Development identity. |
| Secret   | `MACOS_SIGN_PASSWORD`     | The PKCS#12 export password. Maps to `CSC_KEY_PASSWORD`.                                                                                                                          |
| Secret   | `MACOS_NOTARY_KEY`        | Base64 of the App Store Connect API private key `.p8` file. The workflow writes a private temporary file and maps its absolute path to `APPLE_API_KEY`.                           |
| Variable | `MACOS_NOTARY_KEY_ID`     | The API key's Key ID. Maps to `APPLE_API_KEY_ID`.                                                                                                                                 |
| Variable | `MACOS_NOTARY_ISSUER_ID`  | The issuer UUID for that API key. Maps to `APPLE_API_ISSUER`. Use a team API key with access to notarization.                                                                     |
| Variable | `MACOS_TEAM_ID`           | The ten-character Apple Developer Team ID. The verifier requires this TeamIdentifier on both the app and Engine.                                                                  |

The workflow decodes the PKCS#12 into a private temporary file and sets
`CSC_LINK` to that file. electron-builder imports it into its temporary keychain,
uses a generated keychain password, and deletes the keychain on completion.
`APP_BUILDER_TMP_DIR` confines that keychain to the job's signing scratch
folder. An `always()` step also deletes any surviving scratch keychains and
removes the decoded PKCS#12 and `.p8` on success or failure. Hosted runners are
discarded after the job. Shell tracing is off and secret values are not printed.
Local snapshots turn off identity discovery and never use personal identities.

`GITHUB_TOKEN` is supplied by GitHub Actions. It is not a PAT Jim must create.
The reusable workflow declares the four required secrets explicitly; the caller
passes only those secrets. The guard uses the built-in token to read the draft.
The final publisher obtains a short-lived App token with Contents write and
Administration read, verifies immutability, and publishes the complete draft.

## Release a version

The root and desktop `package.json` versions are both `0.1.0`. Release Please
owns both versions, the desktop workspace version in `bun.lock`, and the root `CHANGELOG.md`. Its manifest starts at `0.0.0`,
with `initial-version: 0.1.0` and bootstrap commit
`838d3027b1152325108d06a6a43e2362bd71f973`. There were no tags or releases when
this configuration was introduced. Do not move the bootstrap commit or rewrite
history after the first release.

The lockfile version has an `x-release-please-version` annotation for the generic updater. Bun can remove comments when regenerating its lockfile; restore that annotation on the desktop workspace version after dependency changes. `mise run release:check`, included in `check`, rejects missing annotations or mismatched versions.

1. Merge conventional commits into main. Release Please opens or updates one
   version PR. Check the versions and changelog in that PR.
2. Merge the reviewed version PR. Release Please creates an explicit `vX.Y.Z`
   tag and a **draft** release with its full target commit SHA.
3. The caller passes `release_created`, `sha`, and `tag_name` directly into the
   reusable desktop workflow. The guard verifies that the checkout and existing
   tag resolve to that SHA, that it belongs to main, that both package versions
   match the tag, and that exactly one matching draft exists.
4. Native jobs build Mac arm64 DMG/ZIP, Mac x64 DMG/ZIP, and Linux x64 AppImage.
   Each Go Engine is cross-compiled explicitly for that target. Mac apps and the
   bundled Engine are Developer ID signed with hardened runtime. electron-builder
   notarizes and staples the app before creating the archives. Verification
   extracts the ZIP, checks both CPU identities, version/revision and Go build
   identity, validates app and Engine signatures/team/runtime, validates the
   stapled ticket, assesses Gatekeeper, mounts the DMG read-only to verify its
   app, and launches the package against an empty kubeconfig. The release job
   also runs a two-version update test on each native target before uploading.
5. Build jobs upload candidates to Actions only. Final assembly requires the
   five downloads, platform verification reports tied to their hashes, and
   matching updater metadata. It merges the two Mac manifests into one
   `latest-mac.yml`, verifies every SHA-512 and size reference, and creates
   `SHA256SUMS`. Linux has one `latest-linux.yml`.
6. The final job attaches all downloads, blockmaps, manifests, reports, and
   checksums to the draft. Existing names must have exactly the same SHA-256;
   conflicting assets are never clobbered. It compares uploaded bytes and the
   complete remote inventory before the single publish operation. The final guard rechecks draft/tag identity and asset inventory after downloading the uploaded bytes. GitHub selects Latest using semantic-version ordering, so an older retry does not replace a newer release as Latest. It then
   requires `immutable: true`, verifies `gh release verify`, and verifies every
   asset with `gh release verify-asset`.

No job mutates assets or tags after publication. A post-publication correction
is a new version. If attestation verification fails after publication, investigate
that published release and retry verification manually. Do not rerun publication.

## Retry a failed draft

Prefer **Actions > failed Desktop release run > Re-run failed jobs**. This keeps
the same SHA/tag and reuses successful candidate artifacts from that run. They
are retained for 14 days. A failed assembly or upload leaves the release draft
unpublished. A retry accepts already-attached candidates only when their
SHA-256 matches; it never replaces a conflicting file. The workflow serializes
runs by tag, with cancellation disabled.

For a failure before assets were attached, **Desktop release > Run workflow**
accepts the original full `sha` and original `tag`. It rebuilds that exact
commit, repeats all native checks, and refuses a published release. Signing,
notarization, and archive timestamps can change bytes between builds, so a full
rebuild is not a way to repair a partially populated draft. Reuse the original
run's candidates. If those artifacts have expired or a mismatch is reported,
stop and inspect it; do not delete or replace assets automatically. Discarding
an unpublished candidate requires an explicit maintainer decision. A published
release always requires a new version.

## Build and verify without publishing

Run `mise run setup` first in a fresh checkout. These commands do not publish,
create tags, or access signing credentials:

```sh
mise run package -- arm64 # on macOS; use x64 for Intel or Linux
mise run release:verify -- .data/packages/snapshot/0.1.0-snapshot/mac-arm64 mac-arm64 snapshot
mise run update:verify -- arm64
```

`package` builds a `-snapshot` version under `.data/packages/snapshot/`. Its
menu explains that updates are unavailable. Both snapshots and ordinary
development runs have public checks disabled. `package:test` builds stable
throwaway versions with a separate marker. Only these test packages accept
`HUKUBE_UPDATE_TEST_FEED`, and that URL must use loopback HTTP. Release packages
ignore it. `package:release` requires exact release identity and, on macOS,
explicit signing/notarization inputs; it still passes `publish: never`.

`update:verify` builds `0.0.1` and `0.0.2`, launches the first package with an
isolated profile and empty kubeconfig, serves the second package and builder
metadata from a controlled loopback feed, and drives the native menu. It uses
the same electron-updater metadata, download, digest verification and installer
as GitHub, with the generic provider substituting for GitHub discovery. On
Linux it installs the AppImage, compares the installed bytes, then launches the
updated UI and checks its bundled Engine. On a Mac without a Developer ID
signature it must reach Squirrel and reject installation while leaving the
running app usable. That is download/rejection evidence, not proof of a
successful native Mac installation.

The release workflow runs the same test with `HUKUBE_SIGN_UPDATE_TEST=1` on its
Mac runners and the isolated CI signing inputs. Test packages are then signed
with the same identity, and must successfully install the second version and
launch it. They are not notarized or published. Both real release architectures
must separately pass notarization/Gatekeeper and archive checks. Linux native
installation and signed Mac installation cannot be claimed from a local unsigned
Mac run. The first credential-equipped release must also verify public GitHub
update discovery from an installed preceding signed version to the next signed
version. A first release has no preceding public version.

## Update behavior and trust

Manual **Check for Updates** is in the Mac application menu and Linux Help
menu. Checking and downloading have disabled, labelled menu states with download
progress. Manual checks show an up-to-date result or useful failure feedback.
Background checks begin 30 seconds after startup and repeat every six hours;
checks/downloads never overlap. Background failures leave the app usable and
make a retry available in the menu. A completed download offers a native
notification where supported and retains **Restart to Update** in the menu.
**Later** leaves the update ready. There is no timed restart or new shortcut.

Restart closes windows through their existing unload guards before invoking the
installer. Cancelling a window leaves the Engine and ready update running.
The Engine stops only during the final, accepted quit. On macOS Squirrel first
validates/stages the signed ZIP and can also apply it after an ordinary accepted
quit. Linux requires the AppImage and a writable file/folder; extracted `dir`
installations are not updatable. Verification uses an empty or isolated e2e
kubeconfig, never Jim's own Cluster configuration.

The merged Mac manifest includes architecture-named files, so v26's MacUpdater
selects arm64 on Apple Silicon (including Rosetta), and x64 on Intel. ZIP files
are mandatory for Squirrel. AppImage uses its embedded blockmap; Mac downloads
have external blockmaps for differential updates and a full-download fallback.

GitHub immutability and release attestations protect the published inventory.
They do not replace client signature validation. electron-updater verifies
metadata digests and Squirrel checks Mac signing identity. Linux AppImage uses
metadata SHA-512 over HTTPS and does not gain Developer ID style code signature
validation from this setup. Keep the Mac bundle ID and Apple signing team stable
when renewing or rotating a Developer ID certificate; validate a signed update
from the old installation before shipping the replacement. Notary API key and
GitHub App PEM rotation change CI credentials, not the installed update identity.

The pinned stable builder/updater pair is `26.17.0` / `6.8.10`. Both satisfy the
seven-day cooldown at implementation time. Configuration follows the
[v26 update documentation](https://www.electron.build/v26/docs/features/auto-update/)
and the installed v26 source, rather than v27 prerelease options. See GitHub's
[immutable release setup](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)
and [release verification](https://cli.github.com/manual/gh_release_verify).
