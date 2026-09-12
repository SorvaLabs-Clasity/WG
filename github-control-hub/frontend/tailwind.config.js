/**
 * The Broadsheet theme.
 *
 * The app used to be a GitHub clone dressed up with saturated status colour,
 * rounded cards and drop shadows. This replaces that wholesale with a printed
 * one: warm paper, warm ink, hairline rules, a serif display face and colour
 * reserved for meaning. Nothing in it is a rounded rectangle and nothing casts
 * a shadow, because paper does not.
 *
 * Every colour is a CSS variable rather than a literal, and the variables flip
 * in `.dark`. That matters for more than tidiness: several thousand lines of
 * page markup still carry `slate-900 dark:text-white` pairs from the old
 * design, and mapping *both* halves onto flipping variables means those pairs
 * land on the right ink in either edition instead of having to be hunted down
 * one at a time.
 *
 * The legacy ramps are kept as aliases onto the four printed inks: anything
 * that said rose or red means danger, amber means caution, emerald means
 * settled, blue means information. A ramp step no longer buys a different
 * lightness, it buys wash / edge / ink / deep, which is all a printed page has.
 */

/** rgb(var) with Tailwind's alpha slot, so `/40` still works everywhere. */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** wash → tinted paper, edge → hairline, ink → the mark, deep → solid stamp. */
const printed = (hue) => ({
  50: v(`${hue}-wash`),
  100: v(`${hue}-wash`),
  200: v(`${hue}-edge`),
  300: v(`${hue}-edge`),
  400: v(hue),
  500: v(hue),
  600: v(hue),
  700: v(hue),
  800: v(`${hue}-deep`),
  900: v(`${hue}-deep`),
  950: v(`${hue}-wash`),
  DEFAULT: v(hue),
  wash: v(`${hue}-wash`),
  edge: v(`${hue}-edge`),
  deep: v(`${hue}-deep`),
});

/** Paper on one end, ink on the other, warm the whole way. */
const stock = {
  50: v("paper"),
  100: v("paper-2"),
  200: v("paper-3"),
  300: v("paper-4"),
  400: v("ink-4"),
  500: v("ink-3"),
  600: v("ink-2"),
  700: v("ink-2"),
  800: v("ink"),
  900: v("ink"),
  950: v("ink"),
};

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      /**
       * The three faces, and which is which, is the theme's decision.
       *
       * `serif` is the display face and `sans` the running one whatever the
       * theme calls them: under Terminal both resolve to the same monospace,
       * under Swiss both resolve to the same grotesque. The names are kept
       * because several thousand lines of markup already say `font-mono`.
       */
      fontFamily: {
        serif: "var(--font-display)",
        sans: "var(--font-ui)",
        mono: "var(--font-mono)",
      },

      colors: {
        paper: { DEFAULT: v("paper"), 2: v("paper-2"), 3: v("paper-3"), 4: v("paper-4") },
        ink: { DEFAULT: v("ink"), 2: v("ink-2"), 3: v("ink-3"), 4: v("ink-4") },

        /** The page's own ground, whichever edition is running. */
        stock: v("paper"),
        /** Text and marks that sit on an inked surface. */
        reverse: v("paper"),

        rule: { DEFAULT: v("rule"), strong: v("rule-strong"), heavy: v("ink") },

        /** The four printed inks. Every other colour name aliases one of them. */
        crimson: printed("crimson"),
        ochre: printed("ochre"),
        forest: printed("forest"),
        indigo: printed("indigo"),

        /* ── legacy ramps, re-pointed ───────────────────────────────── */
        slate: stock, gray: stock, zinc: stock, neutral: stock, stone: stock,

        red: printed("crimson"), rose: printed("crimson"),
        pink: printed("crimson"), fuchsia: printed("crimson"),

        amber: printed("ochre"), yellow: printed("ochre"), orange: printed("ochre"),

        green: printed("forest"), emerald: printed("forest"),
        lime: printed("forest"), teal: printed("forest"),

        blue: printed("indigo"), sky: printed("indigo"), cyan: printed("indigo"),
        violet: printed("indigo"), purple: printed("indigo"),

        gh: {
          dark: v("ink"), light: v("paper-2"), bg: v("paper"),
          border: v("rule-strong"), text: v("ink"), textBase: v("ink"),
          muted: v("ink-2"), textMuted: v("ink-2"),
          blue: v("indigo"), blueHover: v("indigo-deep"),
          green: v("forest"), red: v("crimson"),
          "hover-gray": v("paper-2"), canvas: v("paper"), nav: v("paper"),
        },
        github: {
          dark: v("ink"), light: v("paper-2"), border: v("rule-strong"),
          hover: v("paper-2"), primary: v("indigo"), secondary: v("ink-2"),
        },
        status: {
          public: v("forest"), publicBg: v("forest-wash"),
          private: v("ochre"), privateBg: v("ochre-wash"),
        },
      },

      /**
       * `white` and `black` split by property, which Tailwind allows and which
       * this theme genuinely needs: `bg-white` wants the page's own stock, and
       * `text-white` wants whatever is legible where it was written. Pointing
       * both at one value would make one of the two invisible in one edition.
       */
      backgroundColor: { white: v("paper"), black: v("ink") },

      /**
       * Text needs its own neutral ramp.
       *
       * As a *surface* a high slate step meant "dark", which on a flipping
       * variable has to become paper; as *ink* the same step meant "the
       * darkest thing on the page", which has to become ink. The old markup
       * carries both readings of the same class name, so the two properties
       * are given two ramps: here every step lands somewhere legible on the
       * page's own stock, and only the middle of the ramp is allowed to fade.
       */
      textColor: {
        white: v("ink"), black: v("ink"),
        ...Object.fromEntries(["slate", "gray", "zinc", "neutral", "stone"].map((n) => [n, {
          50: v("ink"), 100: v("ink"), 200: v("ink"), 300: v("ink-4"),
          400: v("ink-3"), 500: v("ink-3"), 600: v("ink-2"), 700: v("ink-2"),
          800: v("ink"), 900: v("ink"), 950: v("ink"),
        }])),
      },
      borderColor: { white: v("rule-strong"), black: v("ink"), DEFAULT: v("rule") },
      ringColor: { white: v("rule-strong"), black: v("ink") },
      divideColor: { white: v("rule"), black: v("ink") },

      /**
       * Corner radius and shadow are theme decisions, not app ones.
       *
       * Broadsheet, Swiss and Terminal resolve every step to zero; Control
       * restores a real radius ramp; Risograph keeps the corners square and
       * spends the shadow on a hard offset instead. Routing them through
       * variables is what lets one `rounded-2xl` in the markup mean the right
       * thing in all five.
       */
      borderRadius: {
        none: "0", sm: "var(--r-sm)", DEFAULT: "var(--r)", md: "var(--r-md)",
        lg: "var(--r-lg)", xl: "var(--r-xl)", "2xl": "var(--r-2xl)",
        "3xl": "var(--r-3xl)", "4xl": "var(--r-3xl)",
        full: "9999px",
      },

      boxShadow: {
        none: "none", sm: "var(--shadow-sm)", DEFAULT: "var(--shadow)",
        md: "var(--shadow-md)", lg: "var(--shadow-lg)", xl: "var(--shadow-xl)",
        "2xl": "var(--shadow-xl)", inner: "none",
        press: "var(--shadow-press)",
      },

      letterSpacing: {
        caps: "0.14em",
        capsWide: "0.2em",
      },

      transitionTimingFunction: {
        page: "cubic-bezier(0.22, 1, 0.36, 1)",
      },

      animation: {
        "fade-in": "fadeIn 0.3s ease-out forwards",
        "slide-up": "rise 0.42s cubic-bezier(0.22,1,0.36,1) forwards",
        shine: "none",
        gradientBG: "none",
        fadeInUp: "rise 0.5s cubic-bezier(0.22,1,0.36,1) backwards",
        fadeInDelayed: "fadeIn 0.6s ease-out forwards",
        "pulse-once": "markPulse 1.8s ease-out forwards",
        "slide-in-right": "slideIn 0.26s cubic-bezier(0.22,1,0.36,1) forwards",
        "scale-in": "fadeIn 0.18s ease-out forwards",
      },

      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        rise: {
          "0%": { opacity: "0", transform: "translateY(0.5rem)" },
          "100%": { opacity: "1", transform: "none" },
        },
        slideIn: {
          "0%": { opacity: "0", transform: "translateX(1rem)" },
          "100%": { opacity: "1", transform: "none" },
        },
        markPulse: {
          "0%": { backgroundColor: "rgb(var(--ochre-wash))" },
          "35%": { backgroundColor: "rgb(var(--ochre-wash))" },
          "100%": { backgroundColor: "transparent" },
        },
        /* Kept under their old names so nothing that referenced them breaks. */
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(0.5rem)" },
          "100%": { opacity: "1", transform: "none" },
        },
        fadeInUp: { to: { opacity: 1, transform: "none" } },
        slideInRight: {
          "0%": { transform: "translateX(1rem)", opacity: "0" },
          "100%": { transform: "none", opacity: "1" },
        },
        scaleIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        highlightPulse: {
          "0%": { backgroundColor: "rgb(var(--ochre-wash))" },
          "100%": { backgroundColor: "transparent" },
        },
        gradientBG: { "0%": { opacity: "1" }, "100%": { opacity: "1" } },
        shine: { "100%": { opacity: "1" } },
      },
    },
  },
  plugins: [],
};
