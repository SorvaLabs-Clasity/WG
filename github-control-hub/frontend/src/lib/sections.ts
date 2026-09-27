/**
 * What opens each section, in one place.
 *
 * The section line and the route door both read this. They used to keep their
 * own lists, and the lists drifted: the Alarms tab was offered to anybody who
 * could manage their *own* alarms, and the page then told them it was not open
 * to them — their own alarms live on My work. Only the door on four of the
 * eleven routes checked at all, so opening any other section by its address,
 * or having the desktop app reopen on it, showed raw refusals instead of a
 * locked door.
 *
 * `repro-permissiongates.ts` checks every key here against the vocabulary.
 */
export const SECTION_PERMISSIONS = {
  // Any of its views. A person's own alarms and notification settings live
  // here and nowhere else, so holding only those still has to open it.
  "/my-work": ["me.work.read", "me.repos.read", "me.push.check", "me.widgets.read",
    "me.alarms.read", "me.alerts.read", "me.destination.read"],
  "/analytics": ["overview.read", "overview.cards.read"],
  "/aws": ["aws.read"],
  // The organization's alarms. A person's own are on My work, under `me.*`.
  "/alarms": ["alarms.org.read"],
  "/access": ["access.read"],
  "/dependencies": ["deps.read"],
  "/graph": ["repos.read"],
  "/pulls": ["pulls.read"],
  "/who-knows": ["expertise.read"],
  "/activity": ["activity.read.own", "activity.read.app.rows", "activity.read.github"],
  "/admin": ["admin.console.open"],
} as const satisfies Record<string, readonly string[]>;

export type SectionPath = keyof typeof SECTION_PERMISSIONS;

export const sectionPermissions = (path: SectionPath): string[] => [...SECTION_PERMISSIONS[path]];
