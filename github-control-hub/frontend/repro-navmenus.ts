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

/**
 * And a screen somebody may not see still has to be a screen they can leave.
 *
 * The navigation — section tabs, the account menu, the theme picker, sign out —
 * is rendered by `<Page>`, and `RequireTeam` used to render its notice *instead
 * of* the page rather than inside it. Somebody not on the admin team therefore
 * got a locked door with no handles: no tabs, no menu, no way out of the app at
 * all. The desktop build reopens on the route it was last closed on and shows
 * no browser chrome, so landing there on launch took no wrong move and offered
 * nothing to click.
 *
 * Read as theme-specific in the report, and was not: every theme draws its
 * navigation from `<Page>`, so every theme lost all of it identically.
 */
console.log("\na locked screen is still a screen you can leave");
{
  const gate = fs.readFileSync("./src/components/RequireTeam.tsx", "utf8");

  // Both states. The spinner mattering too is not fussiness: rendering it
  // outside the page and the notice inside it makes the whole window jump the
  // moment permissions land.
  // Every render of the notice and the spinner, however many states lead to
  // one — the property, not a count of them.
  const renders = [...gate.matchAll(/<(Locked|Spinner)\b/g)].map(m => m.index!);
  const outside = renders.filter(i => !/<Page user=\{user\}>/.test(gate.slice(Math.max(0, i - 200), i)));
  check("the notice is rendered inside the page, which is what carries the nav",
    renders.length >= 2 && outside.length === 0,
    { renders: renders.length, outside: outside.map(i => gate.slice(i, i + 40)) });

  check("  so the section tabs, the account menu and sign out are all present",
    /import \{[^}]*\bPage\b[^}]*\} from "\.\.\/design"/.test(gate),
    "Navbar lives in <Page>; rendering beside it is what removed every control");

  // Said, and then offered. A sentence naming another tab is not a door.
  check("and it offers the way out rather than only naming it",
    /navigate\("\/my-work"\)/.test(gate) && /Go to My work/.test(gate));

  /**
   * The screen stays. Redirecting instead would be the easier fix and the
   * wrong one: somebody who cannot find a screen they have heard about assumes
   * the app is broken, and nothing would tell them the one fact that settles
   * it, which is the team to ask for.
   */
  check("  while still naming the team to ask for",
    /Ask to be added to/.test(gate));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
