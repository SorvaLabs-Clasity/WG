/**
 * The built-in ranking presets: what they are called, and which ones the form
 * still offers.
 *
 * Its own module so it can be read without the page, which drags in the React
 * tree and Vite's env. Two lists rather than one because they answer different
 * questions — what a stored widget is named, and what a new one may be.
 */
/**
 * What each preset is called, in one place.
 *
 * Used by the search box and by the row view. The `<select>` in the form used
 * to be the only place these strings existed, which meant nothing else could
 * name a preset without repeating them.
 */
export const PRESET_LABELS: Record<string, string> = {
  "dependabot": "Dependabot Issues Ranking",
  "vuln-repos": "Repositories with vulnerabilities",
  "bypasses": "Protection Rule Bypasses",
  "renovate-open": "Open Renovate PRs",
};

/**
 * The presets the form still offers.
 *
 * Bypass ranking moved to the insight queries, where it always belonged: both
 * forms ask the backend the same "protection-bypasses-ranking" question, and
 * the preset was only ever a second door onto it.
 *
 * It stays in PRESET_LABELS above rather than being deleted, because widgets
 * created before the move are stored as presets and are left that way. Removing
 * the label would leave those widgets unnamed in the search box and the row
 * view, and rewriting them to the query form would invalidate any alarm set on
 * "bypasses in total", which the query form does not offer.
 */
export const CREATABLE_PRESETS = ["dependabot", "vuln-repos", "renovate-open"];

/**
 * What the preset dropdown lists: the creatable ones, plus whatever this widget
 * is already set to.
 *
 * Without the second half, opening an existing bypass widget to change its
 * title puts the form in a state where `presetId` is "bypasses" and no option
 * says so. A `<select>` given a value it does not have shows the first option
 * instead, so the form would sit there claiming the widget was a Dependabot
 * ranking, and saving would make that true.
 */
export function presetOptions(current: string | undefined): string[] {
  return current && !CREATABLE_PRESETS.includes(current)
    ? [...CREATABLE_PRESETS, current]
    : CREATABLE_PRESETS;
}
