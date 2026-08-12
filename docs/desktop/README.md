# The desktop app

Electron, wrapping the React UI and running the backend in-process.

## Structure

```
main.ts     Electron main process — window, navigation, updates
server.ts   Starts the Express backend on localhost:4321
preload     The narrow bridge exposed to the renderer
```

The backend is the **same compiled code** the EC2 runs. It is packaged as
`extraResources` alongside a production-only `node_modules`, so the app ships
with its dependencies rather than expecting a toolchain.

## Navigation control

The main process decides what may open inside the window and what must go to
your real browser:

- **Sign-in flows stay inside** — GitHub, and identity providers behind it such
  as Google SSO. Ejecting those to the system browser breaks the OAuth callback
  and produces a white screen
- **Everything else leaves.** Clicking "View in GitHub" opens your browser, not
  a second Chrome inside the app

Distinguishing them is fiddlier than it sounds: an OAuth redirect fires
`will-redirect` rather than `will-navigate`, so the in-flight flag has to be
cleared by something that observes a completed navigation.

## Sessions

The GitHub OAuth window uses a persistent partition, so signing in does not ask
for your password on every launch. Signing out clears those cookies explicitly,
so the next sign-in genuinely asks.

## Versions

| | |
|---|---|
| Electron | 43 |
| Node (bundled) | 22 |
| electron-builder | 26 |

No native modules, which is what made a ten-major Electron jump uneventful.

`electron-store` stays on 8.x deliberately: 9+ is ESM-only and the main process
is CommonJS.

## Read next

- [Updates](updates.md)
