/**
 * The themes this app can be set in.
 *
 * A theme is a way of setting the same application, not a different
 * application: every screen is written once, in one vocabulary — masthead,
 * headline, standfirst, small-cap column head, ruled record, dateline, figure,
 * stamp, text link, ruled field — and the theme decides what each of those
 * looks like. Nothing in any page knows which theme is running.
 *
 * The whole of a theme lives in `src/index.css` as a block of CSS variables
 * (colour, shape, type) plus, where a theme differs in kind rather than in
 * degree, a short list of class overrides. This file is only the register: what
 * each one is called, how it is described to somebody choosing, and which
 * colours to draw its swatch in.
 */

export type Skin =
  | "broadsheet" | "original" | "terminal" | "swiss" | "riso"
  | "cockpit" | "quiet" | "blueprint";
export type Edition = "light" | "dark";

/**
 * Where navigation lives.
 *
 * The one part of a theme that CSS cannot decide on its own, because it is a
 * different tree and not a different treatment. It turned out to be the single
 * largest lever on whether two themes read as two designs: everything else —
 * colour, radius, shadow, typeface, even density — leaves the same silhouette
 * on the screen.
 */
export type NavMode = "masthead" | "rail";

export interface ThemeEntry {
  id: Skin;
  /** Masthead across the top, or a rail down the left. */
  nav: NavMode;
  /** What it is called in the picker. */
  name: string;
  /** The one-line pitch, and the thing that distinguishes it from its neighbours. */
  blurb: string;
  /** Two or three sentences, read only by somebody deciding. */
  detail: string;
  /** Swatches for the card, light edition. Ground, ink, and the signal colour. */
  swatch: [string, string, string];
}

export const THEMES: ThemeEntry[] = [
  {
    id: "broadsheet",
    nav: "masthead",
    name: "Broadsheet",
    blurb: "Printed sheet. Warm paper, a display serif, hairline rules.",
    detail:
      "Set like a newspaper: a masthead over a heavy rule, headlines and figures in a display serif, "
      + "small-cap column heads, and records divided by hairlines. Nothing is rounded and nothing casts a "
      + "shadow. Colour is spent only on meaning — four printed inks and no others.",
    swatch: ["#F7F4ED", "#221E1A", "#9E272A"],
  },
  {
    id: "original",
    nav: "masthead",
    name: "Original",
    blurb: "The design this app had before. GitHub's own palette, a dark header.",
    detail:
      "Not a tribute to the old app — the old app, rebuilt from the commit it was replaced in. "
      + "GitHub's palette down to the hex: #f6f8fa canvas, #d0d7de hairlines, #0969da links, "
      + "#24292f across the top. Inter at 6px radii, soft grey-blue shadows, and labels in sentence "
      + "case rather than small capitals, which is what makes it read as the old app rather than as "
      + "this one wearing its colours. Its night edition is the slate one it always had.",
    swatch: ["#F6F8FA", "#24292F", "#0969DA"],
  },
  {
    id: "terminal",
    nav: "masthead",
    name: "Terminal",
    blurb: "Engineering console. One monospace, a ruled grid, one phosphor.",
    detail:
      "Everything in a single monospace, on a ground ruled into a faint 24px grid, with hard 1px boxes "
      + "and bracketed controls. Light is a drafting sheet; dark is a CRT, where the grid and the caret "
      + "both glow green. The densest of the five, and the one that suits reading a log.",
    swatch: ["#F0F1EC", "#16191B", "#0F6E3F"],
  },
  {
    id: "swiss",
    nav: "masthead",
    name: "Swiss",
    blurb: "International style. Grotesque type, a hard grid, one red.",
    detail:
      "A neue-grotesque set large and flat, a column grid you can see, and a great deal of white. Size, "
      + "position and rule weight do the ranking rather than tint or shadow, and rules are drawn in the "
      + "ink itself rather than in a grey. One signal red; everything else is black and grey.",
    swatch: ["#FFFFFF", "#111111", "#E2231A"],
  },
  {
    id: "riso",
    nav: "masthead",
    name: "Risograph",
    blurb: "Brutalist print. 2px rules, hard offsets, two overprinted inks.",
    detail:
      "Two flat inks overprinted on newsprint, with 2px black rules and shadows that are hard offsets "
      + "rather than blurs — a shape that only exists because the paper moved under the drum. Buttons "
      + "press into their own shadow. The loudest of the five.",
    swatch: ["#F7F4EA", "#111111", "#F0125C"],
  },
  {
    id: "cockpit",
    nav: "rail",
    name: "Cockpit",
    blurb: "Instrument. A left rail, a 13.5px build, zebra rows, no cards.",
    detail:
      "Navigation moves to a rail down the left and the whole build drops to a 13.5px root, which takes "
      + "every padding, gap and type step with it. Boxes give up their outlines for single rules and tables "
      + "rank by stripe, so a deck of cards becomes a readout. Full width, because a monitoring screen that "
      + "stops short is throwing away the columns you opened it for.",
    swatch: ["#E8ECF1", "#0F1723", "#0870A8"],
  },
  {
    id: "quiet",
    nav: "masthead",
    name: "Quiet",
    blurb: "Document. A 17.5px build, one narrow column, no boxes at all.",
    detail:
      "The opposite extreme: a 17.5px root, one 52rem column, very open leading, and no borders, fills or "
      + "shadows anywhere — whitespace does the ranking a box would otherwise do. The labels come out of "
      + "small capitals into sentence case, which changes the texture of every screen more than any other "
      + "single decision in the set.",
    swatch: ["#FCFCFA", "#292926", "#465A8A"],
  },
  {
    id: "blueprint",
    nav: "masthead",
    name: "Blueprint",
    blurb: "Technical drawing. Cyan linework on navy, outlined, gridded.",
    detail:
      "Cyan linework on deep navy: everything outlined, labels set in a monospace, and a fine cyan grid "
      + "under the whole sheet. Dark in both editions — the day edition is a lighter drafting film rather "
      + "than white paper. The one theme here that does not treat a light ground as the natural state of "
      + "a screen.",
    swatch: ["#12263A", "#D6E9F5", "#4FC3F7"],
  },
];

/** Whether this theme puts its navigation down the side. */
export function isRail(id: string | null | undefined): boolean {
  return themeEntry(id).nav === "rail";
}

export const DEFAULT_SKIN: Skin = "broadsheet";

export function themeEntry(id: string | null | undefined): ThemeEntry {
  return THEMES.find(t => t.id === id)
    ?? THEMES.find(t => t.id === DEFAULT_SKIN)
    ?? THEMES[0];
}

export function isSkin(v: unknown): v is Skin {
  return typeof v === "string" && THEMES.some(t => t.id === v);
}
