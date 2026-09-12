/**
 * Design tokens — The Broadsheet.
 *
 * The app was a GitHub clone, then a saturated dashboard of rounded cards,
 * coloured rails and drop shadows. It is now a printed sheet: warm stock, warm
 * ink, hairline rules, a serif display face, and colour spent only where it
 * carries meaning. Nothing is a rounded rectangle, nothing casts a shadow, and
 * no surface floats above another — a page ranks things with rules and type,
 * which is the whole point of the idiom.
 *
 * The token names are the ones the app already imports, deliberately: several
 * thousand lines of markup reference `INTENT`, `TYPE` and `SURFACE`, and
 * re-pointing them converts every one of those call sites at once rather than
 * leaving a half-converted app behind. What each token *means* is new.
 *
 * Colour lives in CSS variables (see index.css) and the variables flip between
 * the day and night editions, so a token almost never needs a `dark:` half.
 * Where one appears below it is because the two editions genuinely want
 * different treatment, not different values of the same treatment.
 */

/** Semantic state. Four printed inks and the page's own. */
export type Intent = "danger" | "warn" | "good" | "info" | "neutral";

interface IntentStyle {
  /** An inked block. For a masthead band, never for a button. */
  solid: string;
  /** Washed stock, for a note set into running text. */
  soft: string;
  /** The ink itself, as text. */
  text: string;
  /** A rule, a dot or a marginal bar in this ink. */
  mark: string;
  /** A hairline in this ink. */
  border: string;
  /** A stamp: inked block, reversed-out type. Rare by design. */
  loud: string;
  /** A figure. Same ink as `text`; kept separate so the two can diverge. */
  figure: string;
}

export const INTENT: Record<Intent, IntentStyle> = {
  danger: {
    solid: "bg-crimson-deep",
    soft: "bg-crimson-wash",
    text: "text-crimson",
    mark: "bg-crimson",
    border: "border-crimson-edge",
    loud: "bg-crimson text-reverse",
    figure: "text-crimson",
  },
  warn: {
    solid: "bg-ochre-deep",
    soft: "bg-ochre-wash",
    text: "text-ochre",
    mark: "bg-ochre",
    border: "border-ochre-edge",
    loud: "bg-ochre text-reverse",
    figure: "text-ochre",
  },
  good: {
    solid: "bg-forest-deep",
    soft: "bg-forest-wash",
    text: "text-forest",
    mark: "bg-forest",
    border: "border-forest-edge",
    loud: "bg-forest text-reverse",
    figure: "text-forest",
  },
  info: {
    solid: "bg-indigo-deep",
    soft: "bg-indigo-wash",
    text: "text-indigo",
    mark: "bg-indigo",
    border: "border-indigo-edge",
    loud: "bg-indigo text-reverse",
    figure: "text-indigo",
  },
  neutral: {
    solid: "bg-ink",
    soft: "bg-paper-2",
    text: "text-ink-2",
    mark: "bg-ink-3",
    border: "border-rule",
    loud: "bg-ink text-reverse",
    figure: "text-ink",
  },
};

/**
 * The type scale.
 *
 * Two faces doing two jobs. The serif sets everything the page is *about* —
 * headlines, standfirsts and every number it reports. The sans sets everything
 * that helps you read it — labels, column heads, controls, running notes. A
 * screen that mixes those two jobs up is the one that reads as a dashboard.
 *
 * `display`, `figure` and `standfirst` are classes from index.css rather than
 * utility strings: they carry `font-variant-numeric` and the serif stack, which
 * are worth defining once.
 */
export const TYPE = {
  /** The number a whole screen exists to report. One per screen at most. */
  display: "display figure text-[clamp(3.25rem,6.5vw,4.75rem)]",
  /** A headline figure inside a section. */
  metric: "display figure text-[clamp(2.5rem,4.5vw,3.5rem)]",
  /** A count beside a record. Large enough to be read down a column. */
  metricSm: "display figure text-[2rem]",
  /** A page or section headline. */
  title: "display text-[clamp(1.75rem,3vw,2.25rem)] leading-[1.06]",
  /** A subhead within a section. */
  heading: "display text-[1.0625rem] leading-snug",
  body: "text-[14px] leading-relaxed",
  sub: "text-[13px] leading-relaxed",
  /** Small capitals. The only label idiom in the app. */
  label: "caps",
  mono: "font-mono text-[12.5px]",
  /** The italic serif line under a headline. */
  standfirst: "standfirst text-[15px]",
};

/**
 * Whose install this is. Set VITE_COMPANY_NAME at build time; the app is meant
 * to be handed to another company without editing components to do it.
 */
export const COMPANY_NAME: string =
  (import.meta.env.VITE_COMPANY_NAME as string | undefined) || "Control Hub";

/**
 * The paper this is printed on.
 *
 * There is one stock and it is the page's. A `card` is not a raised surface,
 * it is a ruled box — the sidebar treatment a newspaper uses when a reading
 * belongs beside the story rather than in it. `inset` is the only tinted
 * ground, and it is one step of warmth, not a different colour.
 */
export const SURFACE = {
  page: "page-ground text-ink",
  /** A ruled box. Radius and shadow utilities resolve to nothing app-wide. */
  card: "bg-paper border border-rule",
  /** Hover is a wash of ink, not a lift. Paper does not lift. */
  cardHover: "transition-colors duration-150 hover:bg-ink/[0.035]",
  /** A heavier box, for something opened on top of the page. */
  sheet: "bg-paper border border-rule-strong",
  /** Recessed ground for a row inside a box. */
  inset: "bg-paper-2 border border-rule",
  /** Nothing floats here. Kept so old call sites resolve to a no-op. */
  raised: "",
  /** A field is an underline. */
  input:
    "w-full bg-transparent border-0 border-b border-rule-strong px-0 py-2 text-[14px] " +
    "text-ink placeholder:text-ink-4 focus:outline-none focus:border-ink transition-colors",
  /** The masthead rule. */
  nav: "bg-paper border-b-2 border-ink",
};

/** Motion settles type onto the page. It never bounces and never loops. */
export const EASE = "cubic-bezier(0.22,1,0.36,1)";

/**
 * The entrance, staggered by position.
 *
 * `backwards`, not `both`. `rise` animates `transform`, and a forwards-filled
 * animation keeps its final transform applied for the life of the element,
 * outranking any ordinary declaration — which silently beat every hover
 * translate in the previous design. `backwards` holds the opening frame through
 * the stagger delay and then hands the element back to its own styles.
 */
export function enter(index = 0, step = 40, cap = 360): React.CSSProperties {
  return { animation: `rise 0.45s ${EASE} ${Math.min(index * step, cap)}ms backwards` };
}

/**
 * Rules, as shared strings.
 *
 * A section opens on a heavy rule and its rows close on hairlines. Writing that
 * out at every call site is how a sheet ends up with four different weights of
 * line on it.
 */
export const RULE = {
  heavy: "border-t-2 border-ink",
  hair: "border-t border-rule",
  below: "border-b border-rule",
  belowStrong: "border-b border-rule-strong",
  left: "border-l border-rule",
};
