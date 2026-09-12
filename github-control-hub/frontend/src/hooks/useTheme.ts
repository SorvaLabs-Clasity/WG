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
  toggle: () => void;
  setSkin: (skin: Skin) => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  skin: DEFAULT_SKIN,
  toggle: () => {},
  setSkin: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

const EDITION_KEY = "ghch-theme";
const SKIN_KEY = "ghch-skin";

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

export function getInitialSkin(): Skin {
  if (typeof window === "undefined") return DEFAULT_SKIN;
  try {
    const stored = localStorage.getItem(SKIN_KEY);
    if (isSkin(stored)) return stored;
  } catch { /* see above */ }
  return DEFAULT_SKIN;
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
