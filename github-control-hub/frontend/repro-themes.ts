/**
 * The theme register, the stylesheet behind it, and the picker that shows it.
 *
 * A theme is three files that have to agree. `design/themes.ts` says which
 * themes exist; `index.css` holds each one's variables; `ThemePicker.tsx`
 * renders a running copy of each. Nothing at build time connects them, so a
 * theme can be listed with no stylesheet block behind it and it renders as
 * whatever the contract's defaults are — the Broadsheet, under another name,
 * with a plausible blurb underneath. That is a bug nobody reports as a bug.
 *
 * These assert the three stay in step, plus the handful of rules the system
 * rests on that are invisible in any single file:
 *
 *   - the contract is declared on `[data-skin]` rather than on one theme, or a
 *     preview nested inside another theme inherits its ancestor's values;
 *   - idiom overrides are wrapped in `:where()`, so they sit at the same
 *     specificity as the class they replace and still lose to an inline
 *     utility;
 *   - a renamed theme carries its old id forward, or everybody already on it
 *     silently reverts to the default.
 *
 * Run:  npx tsx repro-themes.ts   from github-control-hub/frontend
 */
import fs from "node:fs";
import { THEMES, DEFAULT_SKIN, themeEntry, isSkin, isRail } from "./src/design/themes";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const css = fs.readFileSync("./src/index.css", "utf8");
/** Comments explain the rules using the same selectors; scan the rules. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
const register = fs.readFileSync("./src/design/themes.ts", "utf8");
const picker = fs.readFileSync("./src/components/ThemePicker.tsx", "utf8");
const hook = fs.readFileSync("./src/hooks/useTheme.ts", "utf8");
const navbar = fs.readFileSync("./src/components/Navbar.tsx", "utf8");

(async () => {

console.log("every listed theme is a real theme");
{
  for (const t of THEMES) {
    // The default theme's values *are* the contract, so it has no block of its
    // own by design — that is what lets every other theme state only what it
    // changes. Every other theme needs one, or it renders as the default under
    // its own name, with a plausible blurb underneath.
    check(`  ${t.id} has a palette`,
      t.id === DEFAULT_SKIN
        ? /:root,\s*\n\[data-skin\]\s*\{/.test(rules)
        : rules.includes(`[data-skin="${t.id}"] {`),
      "listed in the register with no block behind it renders as the default");
    check(`  ${t.id} has a night edition`,
      rules.includes(`[data-skin="${t.id}"][data-edition="dark"] {`),
      "without one it inherits the day palette and is unreadable at night");
  }

  // The reverse direction. A block left behind after a theme is removed or
  // renamed is dead weight that still wins specificity arguments.
  const declared = [...rules.matchAll(/\[data-skin="([a-z]+)"\]/g)].map(m => m[1]);
  const orphans = [...new Set(declared)].filter(id => !THEMES.some(t => t.id === id));
  check("and no block belongs to a theme that no longer exists", orphans.length === 0, orphans);

  // Cheap, and the one that catches a copy-paste: two themes sharing an id
  // means one of them can never be chosen.
  const ids = THEMES.map(t => t.id);
  check("and no two themes share an id", new Set(ids).size === ids.length, ids);

  for (const t of THEMES) {
    check(`  ${t.id} is described`,
      !!t.name && !!t.blurb && !!t.detail && t.swatch.length === 3,
      "the picker renders all four, and an empty one reads as a broken card");
  }
}

console.log("\nthe contract every theme starts from");
{
  // The selector, not the theme. Custom properties inherit, so a theme that
  // omits a variable picks up its *ancestor's* value — which for a preview
  // rendered inside the running theme is the wrong theme entirely.
  check("the full contract is declared on [data-skin], not on one theme",
    /:root,\s*\n\[data-skin\]\s*\{/.test(rules),
    "declared on [data-skin=\"broadsheet\"] instead, a nested preview inherits");

  const contractAt = rules.search(/:root,\s*\n\[data-skin\]\s*\{/);
  const firstThemeAt = rules.search(/\[data-skin="[a-z]+"\]\s*\{/);
  check("  and ahead of every theme block, so a theme only states what it changes",
    contractAt >= 0 && firstThemeAt >= 0 && contractAt < firstThemeAt);

  // The strongest structural lever, and the one a new theme forgets.
  check("  including --root-size, which every rem in the build answers to",
    /--root-size:/.test(css) && /font-size:\s*var\(--root-size\)/.test(css));
}

console.log("\nidiom overrides lose to a utility, and beat the base class");
{
  /**
   * `:where()` contributes nothing to specificity, so the override sits at
   * exactly the weight of the class it replaces and wins only by being later.
   * Dropping it silently beats every inline `className="caps text-ink"` in the
   * app, which is how a theme starts overriding colours nobody asked it to.
   *
   * Scoped to the idiom section, because the short list *after* it is the
   * deliberate exception: a handful of places where a theme has to reach a
   * Tailwind utility (`.border` under Cockpit, under Riso) and therefore has
   * to out-specify one. Those are named one at a time on purpose. What must
   * not happen is an idiom override quietly joining them.
   */
  const idiomStart = rules.indexOf("@layer components");
  const utilityStart = css.indexOf("Where a theme has to reach a utility");
  check("  the idiom section and the utility take-overs are still separate",
    idiomStart >= 0 && utilityStart >= 0,
    "if this marker moved, the scan below is looking at the wrong half");

  const idiom = css.slice(css.indexOf("@layer components"), utilityStart)
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const unwrapped = [...idiom.matchAll(/^\s*\[data-skin="[a-z]+"\]\s+\.[a-z-]+/gm)].map(m => m[0].trim());
  check("no idiom override is written without :where()",
    unwrapped.length === 0, unwrapped.slice(0, 5));
}

console.log("\nthe theme somebody had before is still one of the options");
{
  const original = THEMES.find(t => t.id === "original");
  check("Original is in the register", !!original);
  check("  and is called that", original?.name === "Original");

  // Reproduced from the commit it replaced, not from memory. These are the
  // literal values out of the old tailwind.config.js, and they are the reason
  // somebody recognizes it.
  const block = css.slice(css.indexOf('[data-skin="original"] {'));
  check("  and is drawn in the palette it actually had",
    /246 248 250/.test(block)     // #f6f8fa, the canvas
    && /208 215 222/.test(block)  // #d0d7de, the hairline
    && /9 105 218/.test(block),   // #0969da, the link
    "a plausible blue-grey console is not the same thing as the old app");

  // The old app had no small capitals anywhere, and leaving them in is what
  // made the previous attempt read as the new design in old colours.
  check("  with its labels in sentence case, as they were",
    /--caps-transform:\s*none/.test(block.slice(0, block.indexOf("}"))));

  check("  and the header in its own stock",
    /\[data-skin="original"\] \.masthead \{/.test(css) && /className="masthead /.test(navbar),
    "the dark bar is the half of that design somebody recognizes first");

  // A preview that advertises a light bar over an app that shows a dark one is
  // the one lie a running preview is not allowed to tell.
  check("    which the card advertises too",
    /className="masthead bg-paper"/.test(picker));

  // Renaming a theme throws away the choice of everybody already on it unless
  // the old id is mapped forward.
  check("and the id it used to have still resolves",
    /RENAMED/.test(hook) && /control:\s*"original"/.test(hook),
    "anybody already on it opens the app to the default instead");

  // The register is ordered for a reader; the fallback must not be.
  check("and the default is named rather than whichever is listed first",
    /THEMES\.find\(t => t\.id === DEFAULT_SKIN\)/.test(register),
    "reordering the list would silently change what an unknown value falls back to");
  check("  so an unknown id still lands on the default",
    themeEntry("no-such-theme").id === DEFAULT_SKIN);
  check("  and an unknown id is not mistaken for a theme", !isSkin("no-such-theme"));
}

console.log("\nthemes can be starred, and starred ones are findable");
{
  check("the picker reads favourites from the theme context",
    /favorites/.test(picker) && /toggleFavorite/.test(picker));

  check("  kept in the order they were starred, not the register's",
    /favorites\s*\n?\s*\.map\(id => THEMES\.find/.test(picker),
    "filtering THEMES instead would silently re-sort them");

  /**
   * The star is a sibling of the card, not a child. A button inside a button
   * is invalid markup, and browsers resolve it by dropping one of the two —
   * so either starring works and choosing the theme stops, or the reverse,
   * depending on the browser.
   */
  const cardFn = picker.slice(picker.indexOf("function ThemeCard"));
  const cardBody = cardFn.slice(0, cardFn.indexOf("\n}\n"));
  const opens = (cardBody.match(/<button/g) ?? []).length;
  check("  the card is two controls, not one",
    opens === 2, opens);
  check("    and the star opens only after the card's button has closed",
    cardBody.indexOf("</button>") < cardBody.lastIndexOf("<button"),
    "a <button> inside a <button> loses one of them, and which one varies");

  check("  the star is always visible, not revealed on hover",
    !/group-hover[^"]*\bopacity-100\b[^"]*"\s*\n?\s*[^>]*aria-pressed=\{starred\}/.test(picker),
    "seeing which are starred without hovering each is the point");

  check("  and says which way it goes",
    /Add \$\{t\.name\} to favourites/.test(picker) && /Remove \$\{t\.name\} from favourites/.test(picker));

  // An empty section with a heading over it reads as broken rather than empty.
  check("the favourites section is not rendered when there are none",
    /starred\.length > 0 && \(/.test(picker));

  // Starring must not move a card out of the full set: the list is how you
  // find the theme *next* to the one you starred.
  const allGrid = picker.slice(picker.indexOf("All themes"));
  check("  and starring one does not remove it from the full list",
    /\{THEMES\.map\(/.test(allGrid));
}

console.log("\nwhat a theme cannot decide in CSS");
{
  // Navigation is a different tree, not a different treatment, so it lives in
  // the register and is read by <Page> and <Navbar> rather than by a rule.
  check("where navigation lives is declared per theme",
    THEMES.every(t => t.nav === "masthead" || t.nav === "rail"));
  check("  and at least one theme of each kind exists",
    THEMES.some(t => isRail(t.id)) && THEMES.some(t => !isRail(t.id)),
    "if a rail theme is removed the rail layout stops being exercised");
}

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
