/**
 * A feature, and the lists its screen picks from.
 *
 * docs/auth/permissions-model.md: the lists behind a picker — the people, the
 * repositories, the email groups — are data with their own reads, and holding
 * a feature does not open them. So somebody granted "Mute a reminder" without
 * "The list of people" gets a mute window with no people to pick. Rather than
 * widen the lists, the admin console says so when the two are granted apart,
 * with a button that adds what is missing.
 *
 * Each entry is a screen read in this codebase: the hook that loads the list
 * is gated on the read named here.
 */
export const PERMISSION_NEEDS: Record<string, string[]> = {
  // PrReminderSettings: the people picker and the repository picker.
  "pulls.mute": ["org.members.read", "repos.read"],
  // AlarmModal, outside a personal board: who the email goes to.
  "alarms.org.create": ["alarms.groups.read"],
  "alarms.org.edit": ["alarms.groups.read"],
  "aws.rules.edit": ["alarms.groups.read"],
  // ImportantEventsPanel and VulnNotifyPanel: the settings, and the group they send to.
  "alarms.security.manage": ["alarms.security.read", "alarms.groups.read"],
  "alarms.feeds.manage": ["alarms.feeds.read", "alarms.groups.read"],
};

/** Each held feature missing a list it needs, with the reads to add. */
export function missingNeeds(
  held: (key: string) => boolean,
  known: (key: string) => boolean,
): { feature: string; missing: string[] }[] {
  const out: { feature: string; missing: string[] }[] = [];
  for (const [feature, needs] of Object.entries(PERMISSION_NEEDS)) {
    if (!known(feature) || !held(feature)) continue;
    const missing = needs.filter(n => known(n) && !held(n));
    if (missing.length) out.push({ feature, missing });
  }
  return out;
}
