/**
 * A menu a layout renders twice must still work in both copies.
 *
 * Run from github-control-hub/frontend:  npx tsx repro-navmenus.ts
 *
 * The Cockpit theme moves navigation to a rail down the left, and that layout
 * draws the account block twice: once at the foot of the rail for wide windows,
 * once in the narrow-window bar. Two ways of writing that are fine everywhere
 * else and wrong here, and both shipped:
 *
 *   A shared `ref`. React assigns it per mounted instance, so the *last* one
 *   wins — which is the hidden copy. The outside-click handler then judged
 *   every click in the visible menu to be outside it, closed the menu on
 *   mousedown, and the button was gone before mouseup, so React never
 *   dispatched the click. Appearance did nothing at all under Cockpit, with no
 *   error anywhere.
 *
 *   A placement derived from the theme rather than from the position. The rail
 *   hangs its menu upwards off the foot of a side column; the narrow bar is
 *   pinned to the top of the window, where the same menu opens above the
 *   viewport and cannot be reached.
 *
 * Source rules rather than a rendering test, for the same reason the rest of
 * these are: both causes are shapes that can be seen in the file, and both were
 * invisible in a screenshot of either layout on its own.
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const nav = fs.readFileSync("src/components/Navbar.tsx", "utf8");

console.log("a menu rendered more than once is not found by ref");
{
  /**
   * The dismissal asks "is this click inside *an* account menu", which is the
   * question that was actually meant. A ref can only answer "inside *the* one
   * I happen to point at".
   */
  check("the outside-click dismissal matches by marker, not by ref",
    /closest\?\.\(`\[\$\{ACCOUNT_MARK\}\]`\)/.test(nav) && /const ACCOUNT_MARK/.test(nav),
    "a ref is claimed by whichever copy mounts last");

  check("  and no ref is used to decide it",
    !/accountRef/.test(nav),
    "the ref that caused this is gone, not merely unused");

  // The marker has to be on the element the menu lives in, or `closest` walks
  // past it and the dismissal is back to firing on its own menu.
  check("  and the marker sits on the menu's own wrapper",
    /\{\.\.\.\{ \[ACCOUNT_MARK\]: "" \}\}/.test(nav));
}

console.log("\nwhere a menu opens is a property of the position, not the theme");
{
  check("placement is passed in",
    /placement: "up" \| "down"/.test(nav));

  check("  and decides the direction",
    /placement === "up" \? "left-0 bottom-full[^"]*" : "right-0 top-full/.test(nav),
    "a menu in a bar pinned to the top of the window must open downwards");

  /**
   * The specific regression. `rail ? ... bottom-full ... : ... top-full` read
   * the theme, so Cockpit's narrow-window bar — which is a top bar like every
   * other theme's — opened its menu above the viewport.
   */
  check("  never from which theme is running",
    !/rail \?\s*"[^"]*bottom-full/.test(nav),
    "Cockpit's narrow bar is a top bar and opens downwards like the rest");

  // Exactly one upward call site: the foot of the rail. Everything else is a
  // bar across the top.
  const up = (nav.match(/placement=\{"up"\}/g) ?? []).length;
  const down = (nav.match(/placement=\{"down"\}/g) ?? []).length;
  check("  one menu opens upward, and it is the rail's",
    up === 1 && down >= 2, { up, down });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
