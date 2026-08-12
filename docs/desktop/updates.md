# Updates

`electron-updater` against GitHub Releases, on a private repository.

## The flow

1. App starts, waits for AWS to connect
2. Fetches the system GitHub token from its own backend
3. Asks GitHub for the latest **published** release
4. Downloads and installs if the version is newer

Step 2 is why updates wait for AWS: the token lives in Secrets Manager, and a
private repository's releases cannot be read without one.

## Releasing

Push a tag matching the version in `desktop/package.json`. CI builds for macOS
and Windows, publishes a draft release, then a second job flips it to `latest`.

That second step matters — GitHub's "latest release" endpoint **ignores
drafts**. A build that stops at draft leaves every installed copy fetching a
404, with a message about authentication tokens that sends people looking in
entirely the wrong place.

## Publish configuration

`build.publish` must carry `owner` and `repo`. electron-builder 25 tolerated
their absence; **26 resolves the provider to null and crashes any build**, not
only a publishing one. CI overrides both from the checkout, so a fork releases
to itself.

## Building locally

```bash
cd github-control-hub/desktop
npm run dist:mac     # .dmg + .zip in release/
npm run pack         # unpacked .app, faster, for smoke tests
```

Local builds do not publish — there is no `GH_TOKEN` in the environment.

## Signing

macOS builds are ad-hoc signed, not notarised. Gatekeeper will warn on first
open. Notarising needs an Apple Developer account and is worth doing before
handing the app to a wider group.
