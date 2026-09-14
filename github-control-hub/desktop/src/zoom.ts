/**
 * Ctrl/Cmd + and Ctrl/Cmd − , which every other window on the machine has.
 *
 * The app had no zoom at all, and the reason is one line in `main`:
 *
 *     Menu.setApplicationMenu(null);
 *
 * Electron's default menu is where the standard accelerators live. `zoomIn`,
 * `zoomOut` and `resetZoom` are menu *roles*, so Ctrl+= and Ctrl+− are not
 * built into the window — they are built into a View menu that this app throws
 * away to get a chrome-less frame. Nothing else registers them, so the keys do
 * nothing, on both platforms.
 *
 * Handled here at the input layer instead, which keeps the frame bare. The
 * alternative — putting a menu back, hidden, purely to carry three
 * accelerators — means a menu bar that reappears on Windows whenever Alt is
 * pressed, and an app that has to maintain a menu it never shows.
 *
 * ## Matching the key rather than the position
 *
 * `input.key` is what the layout produces; `input.code` is which physical key
 * was hit. Zoom has to follow the layout, because "the plus key" is not in the
 * same place on a US, German and French keyboard, and on all three the thing
 * the person is looking at when they reach for zoom is the printed `+`.
 *
 * Which means accepting more than one spelling of each:
 *
 *   - `+` is usually Shift and the `=` key, so plain `=` has to count too.
 *     Nobody presses Ctrl+Shift+= on purpose; they press "control plus".
 *   - `−` is Shift-free, but Shift-and-minus gives `_`, and somebody holding
 *     Shift from the zoom-in they did a moment ago should still zoom out.
 *   - The numeric keypad sends `+` and `-` as well, so it is already covered.
 *
 * ## Steps
 *
 * Electron's zoom level is an exponent: the page scales by `1.2 ** level`. Half
 * steps give about 10% a press, which is fine enough to land on a comfortable
 * size and coarse enough to get there in a few presses. The range is clamped
 * because this app has a 1024×700 minimum window and a layout with real density
 * in it: far enough out and columns collapse into each other, far enough in and
 * the sidebar owns the window.
 */
// Types only. Nothing here calls into Electron, which is what lets the key
// mapping below be exercised by a plain script rather than only by a person
// pressing keys at a window and reporting what they saw.
import type { BrowserWindow, WebContents, Input } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 1.2 ** -3 ≈ 58%, 1.2 ** 3 ≈ 173%. */
const MIN_LEVEL = -3;
const MAX_LEVEL = 3;
const STEP = 0.5;

/**
 * Kept apart from `desktop.json`, which the embedded backend also writes.
 *
 * Both processes would be doing read-modify-write on the same object from
 * different processes, and the interleaving that loses somebody's AWS profile
 * because they pressed Ctrl+− at the wrong moment is not worth the tidiness of
 * a single file.
 */
const DIR = path.join(os.homedir(), ".github-control-hub");
const FILE = path.join(DIR, "window.json");

interface WindowPrefs {
  /** Electron zoom level, not a percentage. */
  zoomLevel?: number;
}

function readPrefs(): WindowPrefs {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as WindowPrefs;
  } catch {
    // Missing, unreadable or corrupt all mean "no preference yet". Remembering
    // a zoom level must never be able to stop the app from opening.
    return {};
  }
}

function writePrefs(update: WindowPrefs): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ ...readPrefs(), ...update }, null, 2), { mode: 0o600 });
  } catch {
    // Same reasoning. A zoom level that does not survive a restart is a small
    // annoyance; a crash on the way to the window is not.
  }
}

export const clamp = (level: number) => Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, level));

/** Round to the step, so a stored value from an older range cannot drift. */
export const snap = (level: number) => Math.round(level / STEP) * STEP;

/** What the accelerator key is on this platform. Cmd on macOS, Ctrl elsewhere. */
function hasZoomModifier(input: Input, platform: NodeJS.Platform): boolean {
  // Alt excluded deliberately: Ctrl+Alt+− is a dead key for an em dash on
  // several layouts, and Cmd+Alt+− belongs to nothing here.
  if (input.alt) return false;
  return platform === "darwin" ? input.meta : input.control;
}

export type ZoomIntent = "in" | "out" | "reset";

/**
 * What this keypress means, if anything.
 *
 * Returns null for the overwhelming majority of keys, which is the point: this
 * runs on every keystroke the window receives, including every character typed
 * into every field.
 *
 * The platform is a parameter rather than read from `process` so that both
 * halves of "Cmd on macOS, Ctrl elsewhere" can be checked from one machine.
 * The claim is about two platforms and only one of them is ever under test.
 */
export function intentOf(input: Input, platform: NodeJS.Platform = process.platform): ZoomIntent | null {
  if (input.type !== "keyDown") return null;
  if (!hasZoomModifier(input, platform)) return null;

  switch (input.key) {
    // "=" is here because "+" costs a Shift on most layouts and nobody thinks
    // of zoom as a shifted shortcut.
    case "+": case "=": return "in";
    // "_" is shifted "-", reached by anyone who has not let go of Shift yet.
    case "-": case "_": return "out";
    case "0": return "reset";
    default: return null;
  }
}

function applyZoom(contents: WebContents, level: number): void {
  const next = clamp(snap(level));
  contents.setZoomLevel(next);
  writePrefs({ zoomLevel: next });
}

/**
 * Give a window its zoom shortcuts, and the level it was left at.
 *
 * Call once per window, after it is created.
 */
export function installZoom(window: BrowserWindow): void {
  const contents = window.webContents;
  const stored = clamp(snap(readPrefs().zoomLevel ?? 0));

  /**
   * Re-applied on every completed load, not just at startup.
   *
   * Electron ties the zoom level to the page's origin within a session, and
   * this window navigates: to `/login`, away to an identity provider during
   * GitHub sign-in, and back again. Setting it once at creation leaves the zoom
   * to survive that by luck. Setting it on `did-finish-load` is one call
   * against a value that is already correct in the common case.
   */
  contents.on("did-finish-load", () => {
    const level = clamp(snap(readPrefs().zoomLevel ?? stored));
    if (contents.getZoomLevel() !== level) contents.setZoomLevel(level);
  });

  contents.on("before-input-event", (event, input) => {
    const intent = intentOf(input);
    if (!intent) return;

    // Before the page sees it. Without this the accelerator still reaches the
    // renderer, where a "-" in a text field is an ordinary character and gets
    // typed as well as zooming.
    event.preventDefault();

    const current = contents.getZoomLevel();
    if (intent === "reset") applyZoom(contents, 0);
    else applyZoom(contents, current + (intent === "in" ? STEP : -STEP));
  });
}
