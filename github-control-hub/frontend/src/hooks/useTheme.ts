import { createContext, useContext } from "react";
import { DEFAULT_SKIN, isSkin, type Edition, type Skin } from "../design/themes";

/**
 * Two independent choices, and they are independent on purpose.
 *
 * `skin` is which of the five themes the app is set in. `theme` is which
 * edition of that theme — light or dark. Every theme has both, so switching
 * one never silently changes the other, and somebody who works at night does
 * not have to give up the typeface they chose to stay there.
 *
 * Kept under the old names where anything already imported them: `Theme` is
 * still the light/dark axis, and `toggle` still flips it.
 */
export type Theme = Edition;
export type { Edition, Skin };

export interface ThemeContextValue {
  theme: Edition;
  skin: Skin;
  /** Starred themes, in the order they were starred. */
  favorites: Skin[];
  toggle: () => void;
  setSkin: (skin: Skin) => void;
  toggleFavorite: (skin: Skin) => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  skin: DEFAULT_SKIN,
  favorites: [],
  toggle: () => {},
  setSkin: () => {},
  toggleFavorite: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

const EDITION_KEY = "ghch-theme";
const SKIN_KEY = "ghch-skin";
const FAVORITES_KEY = "ghch-skin-favorites";

export function getInitialTheme(): Edition {
  if (typeof window === "undefined") return "light";
  try {
    const stored = localStorage.getItem(EDITION_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // A private window throws on read. The system's preference is the better
    // fallback than an assumption either way.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Themes that have been renamed, and what they are now.
 *
 * A theme id is stored in the browser, so renaming one in the register throws
 * away the choice of everybody already on it — they open the app and it is the
 * default, which reads as the app having lost their setting rather than as a
 * rename. Mapping the old id forward costs a line and lasts forever.
 *
 * `control` became `original` when it was rebuilt from the commit it was
 * reproducing rather than from memory. Same slot, same intent, different
 * fidelity.
 */
const RENAMED: Record<string, Skin> = { control: "original" };

export function getInitialSkin(): Skin {
  if (typeof window === "undefined") return DEFAULT_SKIN;
  try {
    const stored = localStorage.getItem(SKIN_KEY);
    if (isSkin(stored)) return stored;
    if (stored && RENAMED[stored]) return RENAMED[stored];
  } catch { /* see above */ }
  return DEFAULT_SKIN;
}

/**
 * The themes somebody has starred.
 *
 * Kept in the order they were starred rather than in register order: the list
 * is short, and "the one I picked first" is a more useful order than
 * alphabetical or whatever order the file happens to declare them in.
 *
 * Filtered through `isSkin` on the way in, so a theme that is later renamed or
 * removed drops out of the list instead of leaving a card that cannot be drawn.
 * `RENAMED` is applied first, for the same reason it is applied to the current
 * choice: a rename should not quietly unstar anything.
 */
export function getInitialFavorites(): Skin[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Skin[] = [];
    for (const v of parsed) {
      const id = isSkin(v) ? v : (typeof v === "string" ? RENAMED[v] : undefined);
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  } catch {
    // Unreadable storage, or something else's value under our key. An empty
    // list is the honest answer and costs nothing.
    return [];
  }
}

export function saveFavorites(favorites: Skin[]): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    // Same as the other two: not being able to remember it does not stop it
    // applying for this session.
  }
}

/**
 * Puts both choices on the root element.
 *
 * `data-edition` is what the stylesheet's colour blocks key off, and `.dark` is
 * kept beside it because several thousand lines of markup still use Tailwind's
 * `dark:` variant. Both are needed; neither is redundant.
 */
export function applyTheme(theme: Edition, skin: Skin = getInitialSkin()) {
  const root = document.documentElement;
  root.dataset.edition = theme;
  root.dataset.skin = skin;
  root.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(EDITION_KEY, theme);
    localStorage.setItem(SKIN_KEY, skin);
  } catch {
    // Not being able to remember the choice does not stop it applying now.
  }
}
