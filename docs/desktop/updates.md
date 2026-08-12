# Updates and releases

`electron-updater` against GitHub Releases, on a private repository.

## Cutting a release

**Bump the version, then push to `main`.** There is no separate tagging step.

```bash
cd github-control-hub/desktop
npm version patch        # or minor / major
git push origin main
```

`.github/workflows/release.yml` triggers on **push to `main`** and does the
rest:

1. Builds backend, frontend and the Electron app on macOS **and** Windows
2. `electron-builder --publish always` creates a **draft** release named
   `v<version>` and uploads the installers plus the update manifests
   (`latest-mac.yml`, `latest.yml`) that `electron-updater` reads
3. A second job runs `gh release edit v<version> --draft=false --latest`

Step 3 is not decoration. GitHub's "latest release" endpoint **ignores
drafts**, so a run that stops at step 2 leaves every installed copy fetching a
404 — with a message about authentication tokens that sends people looking
nowhere near the cause.

`owner` and `repo` are passed from the checkout rather than `package.json`, so
a fork releases to itself.

## Bump the version, every time

The workflow runs on **every** push to `main`, including documentation-only
ones. If the version has not changed, `v<version>` already exists and the
publish step fails.

It is not harmful, but it puts a red cross on commits that only touched
markdown — and a workflow that is normally red is a workflow whose real
failures nobody notices. Either bump the version, or gate the workflow with a
`paths-ignore` for `docs/**`.

## How an installed copy updates

On launch the app:

1. Waits for AWS to connect — the GitHub token lives in Secrets Manager
2. Fetches that token from its own backend and hands it to `electron-updater`
3. Asks GitHub for the latest **published** release
4. Downloads and installs if the version is newer, then prompts to restart

Step 1 is why updates wait for AWS: a private repository's releases cannot be
read without a token.

## Publish configuration

`build.publish` must carry `owner` and `repo`. electron-builder 25 tolerated
their absence; **26 resolves the provider to null and crashes any build**, not
only a publishing one.

## Building locally

```bash
npm run dist:mac     # .dmg + .zip into release/
npm run pack         # unpacked .app, faster, for smoke tests
```

Local builds do not publish — there is no `GH_TOKEN` in the environment.

## Signing

macOS builds are ad-hoc signed, not notarised, so Gatekeeper warns on first
open. Fixing that needs an Apple Developer account, and is worth doing before
handing the app to people who did not build it.
