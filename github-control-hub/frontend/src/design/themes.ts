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

export type Skin = "broadsheet" | "control" | "terminal" | "swiss" | "riso";
export type Edition = "light" | "dark";

export interface ThemeEntry {
  id: Skin;
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
    name: "Broadsheet",
    blurb: "Printed sheet. Warm paper, a display serif, hairline rules.",
    detail:
      "Set like a newspaper: a masthead over a heavy rule, headlines and figures in a display serif, "
      + "small-cap column heads, and records divided by hairlines. Nothing is rounded and nothing casts a "
      + "shadow. Colour is spent only on meaning — four printed inks and no others.",
    swatch: ["#F7F4ED", "#221E1A", "#9E272A"],
  },
  {
    id: "control",
    name: "Control",
    blurb: "Modern console. Rounded cards, real shadows, saturated status colour.",
    detail:
      "The design this app wore before the Broadsheet. Cards with rounded corners on a cool blue-grey "
      + "ground, drop shadows carrying the depth, Inter set heavy and tight, and status colour at full "
      + "strength. The most conventional of the five, and the easiest to hand to somebody new.",
    swatch: ["#F6F7FA", "#0F172A", "#2563EB"],
  },
  {
    id: "terminal",
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
    name: "Risograph",
    blurb: "Brutalist print. 2px rules, hard offsets, two overprinted inks.",
    detail:
      "Two flat inks overprinted on newsprint, with 2px black rules and shadows that are hard offsets "
      + "rather than blurs — a shape that only exists because the paper moved under the drum. Buttons "
      + "press into their own shadow. The loudest of the five.",
    swatch: ["#F7F4EA", "#111111", "#F0125C"],
  },
];

export const DEFAULT_SKIN: Skin = "broadsheet";

export function themeEntry(id: string | null | undefined): ThemeEntry {
  return THEMES.find(t => t.id === id) ?? THEMES[0];
}

export function isSkin(v: unknown): v is Skin {
  return typeof v === "string" && THEMES.some(t => t.id === v);
}
