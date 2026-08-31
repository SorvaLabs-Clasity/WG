/**
 * Turning an alarm into the email that gets sent.
 *
 * Pure string work, kept away from the SNS client so the awkward parts, the
 * subject rules in particular, can be tested without publishing anything.
 */

/** Every variable a template may use, with what it means. The UI lists these. */
export const TEMPLATE_VARIABLES: { name: string; description: string }[] = [
  { name: "widget", description: "The widget's title" },
  { name: "metric", description: "What was measured, e.g. \"Critical alerts\"" },
  { name: "value", description: "The reading that fired this" },
  { name: "threshold", description: "The limit you set" },
  { name: "state", description: "ALARM or OK" },
  { name: "severity", description: "For important events and Dependabot: critical, high, medium, low" },
  { name: "repo", description: "For important events, Dependabot and Renovate: the repository involved" },
  { name: "message", description: "For important events: what happened" },
  { name: "org", description: "The GitHub organization" },
  { name: "time", description: "When the value was observed (UTC)" },
  { name: "title", description: "For Renovate: the pull request title" },
  { name: "url", description: "For Renovate and Dependabot: a link to it on GitHub" },
  { name: "number", description: "For Renovate: the pull request number" },
  { name: "package", description: "For Dependabot: the vulnerable package" },
  { name: "advisory", description: "For Dependabot: the advisory summary" },
  // Filled on a grouped message, where one event's fields describe only one of
  // the many rows the email covers.
  { name: "count", description: "How many events this email covers" },
  { name: "repos", description: "The repositories involved, named or counted" },
  { name: "what", description: "What happened, in a phrase" },
];

const VARIABLE_NAMES = new Set(TEMPLATE_VARIABLES.map(v => v.name));

/**
 * Substitute {{name}} placeholders.
 *
 * An unknown name is left exactly as written rather than blanked. A template
 * reading "{{critical}} found" would otherwise send " found", which looks like
 * a bug in the alarm rather than a typo in the template, and the typo is
 * reported separately at save time by unknownVariables() below, which is when
 * somebody can still fix it.
 */
export function render(template: string, vars: Record<string, string | number | undefined>): string {
  const filled = template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (!VARIABLE_NAMES.has(name)) return whole;
    const v = vars[name];
    return v === undefined || v === null ? "" : String(v);
  });
  return dropEmptyLines(template, filled);
}

/**
 * Remove lines that held nothing but variables, all of which came out empty.
 *
 * Templates have no conditionals, and the same template now renders both a
 * single event and a digest of two hundred. Some variables only exist on one of
 * those paths: `{{url}}` is a link to one alert, and a digest covering forty
 * repositories has no single link to give. Blanking it leaves the line, so the
 * email arrives with a gap exactly where the reader was looking for the link,
 * which reads as a broken email rather than an absent value.
 *
 * Only lines whose entire content was placeholders are removed, so a blank line
 * somebody typed deliberately stays a blank line. A line with any literal text
 * on it, "Package: {{package}}", is left alone: the author wrote a label, and
 * silently dropping their label would be its own surprise.
 */
function dropEmptyLines(template: string, filled: string): string {
  const before = template.split("\n");
  const after = filled.split("\n");
  // A `{{var}}` cannot span lines, so the two always have the same line count
  // and index into each other. Bail rather than guess if that ever stops being
  // true, because mangling somebody's email body is worse than a blank line.
  if (before.length !== after.length) return filled;

  const kept = after.filter((line, i) => {
    const src = before[i];
    // Was it only placeholders to begin with, and is there nothing left?
    const wasOnlyVars = /\{\{\w+\}\}/.test(src) && src.replace(/\{\{\w+\}\}/g, "").trim() === "";
    return !(wasOnlyVars && line.trim() === "");
  });

  // Nothing went, so nothing about the author's spacing is this function's
  // business. Return the rendered text exactly as it came.
  if (kept.length === after.length) return filled;

  // A removed line takes its blank separator with it. Dropping `{{url}}` from
  // the top of a body otherwise leaves the email opening on an empty line, and
  // dropping a line from between two paragraphs leaves a double gap. Both look
  // like the template broke. Only runs created by a drop are touched, which is
  // why this is below the early return.
  return kept
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** Names used in a template that are not real variables. Reported when saving. */
export function unknownVariables(template: string): string[] {
  const found = [...template.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
  return [...new Set(found.filter(n => !VARIABLE_NAMES.has(n)))];
}

/**
 * SNS rejects a subject outright rather than trimming it, and a rejected
 * publish is an alarm that fires into nothing: the evaluator records that it
 * fired, no email arrives, and the next check sees state ALARM and stays quiet.
 * Silence then means both "all clear" and "broken", which is the one thing an
 * alerting system may not do.
 *
 * The rules AWS enforces: ASCII, no line breaks or control characters, and
 * under 100 characters. So every one of them is applied here, to whatever the
 * template produced, rather than hoped for.
 */
export const SUBJECT_MAX = 99;

export function sanitizeSubject(raw: string, fallback = "Control Hub alarm"): string {
  const flattened = raw
    .replace(/[\r\n\t]+/g, " ")
    // Control characters and anything outside printable ASCII. Repository and
    // team names are user-supplied and reach this string.
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // AWS also requires the first character to be a letter, number or
  // punctuation mark, which a subject starting with a stripped emoji would
  // otherwise violate.
  const cleaned = flattened.replace(/^[^A-Za-z0-9\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]+/, "");
  if (!cleaned) return fallback;
  // Truncated with no ellipsis: the only ellipsis worth adding is not ASCII,
  // and "..." spends three of the characters being economised.
  return cleaned.length > SUBJECT_MAX ? cleaned.slice(0, SUBJECT_MAX).trimEnd() : cleaned;
}

export const DEFAULT_ALARM_SUBJECT = "[{{state}}] {{widget}}: {{metric}} is {{value}}";
export const DEFAULT_ALARM_BODY =
  `{{widget}}\n\n{{metric}} is now {{value}} (your limit is {{threshold}}).\n\n` +
  `Organization: {{org}}\nObserved at: {{time}}\n\n` +
  `This is an automated message from GitHub Control Hub.`;

/**
 * The defaults below are written to read correctly as **one** event and as a
 * digest of two hundred, because the same template renders both.
 *
 * Three rules came out of that:
 *
 *   - Nothing leads with `[`. A digest prefixes its own `[12]`, and two
 *     brackets in a row is where a subject stops being scannable.
 *   - Every variable used is one that is populated on both paths. `{{url}}`
 *     and `{{advisory}}` describe a single alert, so on a digest they are
 *     empty and their line is dropped rather than left as a gap.
 *   - `{{repo}}` and `{{package}}` say "40 repositories" or "3 packages" when
 *     the group disagrees, so the sentence stays true either way.
 */
export const DEFAULT_SECURITY_SUBJECT = "{{severity}}: {{message}} in {{repo}}";
export const DEFAULT_SECURITY_BODY =
  `{{message}}\n\nRepository: {{repo}}\nSeverity: {{severity}}\n` +
  `Organization: {{org}}\nDetected at: {{time}}\n\n` +
  `This is an automated message from GitHub Control Hub.`;

// Both of these lead with the link. These emails exist to get somebody to the
// pull request or the advisory, and a reader on a phone should not have to
// scroll past a summary to find the one thing they came for.
export const DEFAULT_RENOVATE_SUBJECT = "{{repo}}: {{title}}";
export const DEFAULT_RENOVATE_BODY =
  `{{url}}\n\nRenovate opened pull request #{{number}} in {{repo}}.\n\n` +
  `{{title}}\n\nOrganization: {{org}}\nOpened at: {{time}}\n\n` +
  `This is an automated message from GitHub Control Hub.`;

export const DEFAULT_DEPENDABOT_SUBJECT = "{{severity}}: {{package}} in {{repo}}";
export const DEFAULT_DEPENDABOT_BODY =
  `{{url}}\n{{advisory}}\n\nPackage: {{package}}\nRepository: {{repo}}\n` +
  `Severity: {{severity}}\nOrganization: {{org}}\nDetected at: {{time}}\n\n` +
  `This is an automated message from GitHub Control Hub.`;

/**
 * A timestamp a person can read, and cannot misread.
 *
 * A raw ISO string is correct and unreadable: to anyone not on UTC the alarm
 * looks hours away, and the only thing saying otherwise is a trailing "Z" lost
 * among the milliseconds.
 *
 * The zone is named because one email reaches a group who may be in several
 * places, and a clock with no zone on it means something different to each.
 */
export function formatTimestamp(iso: string | undefined, timeZone = "UTC"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);

  try {
    // "30 Aug 2026 at 10:30 AM EDT".
    //
    // Was "2026-08-30 14:30 UTC": correct, and read like a log line. A named
    // month cannot be misread the way 08-09 can, depending on which side of
    // the Atlantic the reader learned to write dates, and a twelve-hour clock
    // is what the people receiving these actually use.
    // en-US, and the locale is load-bearing rather than incidental: it is what
    // decides whether the zone reads "EDT" or "GMT-4". en-GB and en-CA give the
    // offset for American zones, which is correct and is not what anybody
    // there calls it.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
    }).formatToParts(d);
    const at = (t: string) => parts.find(p => p.type === t)?.value ?? "";

    const meridiem = at("dayPeriod").toUpperCase();
    const zone = at("timeZoneName");

    return `${at("month")} ${at("day")}, ${at("year")} at ${at("hour")}:${at("minute")}`
      + (meridiem ? ` ${meridiem}` : "")
      + (zone ? ` ${zone}` : "");
  } catch {
    // An unknown zone name throws rather than falling back, and a rejected
    // timestamp would take the whole email with it. UTC is always valid.
    return formatTimestamp(iso, "UTC");
  }
}

/**
 * One moment, written in every clock that will read it.
 *
 * Teams is delivered per person, so it gets each recipient's own zone and this
 * is never needed there. Email is one SNS publish to one topic, which hands
 * every subscriber the identical body: there is no per-person text, and no
 * amount of configuration changes that.
 *
 * So rather than picking one person's zone and being wrong for the rest, or
 * offering a per-person setting for email that could never take effect, the one
 * body carries them all: "Aug 30, 2026 at 10:30 AM EDT (7:30 AM PDT)". Each
 * reader finds their own, and nobody has to subtract.
 *
 * Ordered as given, so the group's own zone leads. Duplicates are dropped,
 * which is the ordinary case: most groups are in one place and this then reads
 * exactly as a single zone.
 */
export function formatTimestampAcross(iso: string | undefined, zones: string[]): string {
  if (!iso) return "";
  const seen = new Set<string>();
  const distinct = zones.filter(z => z && !seen.has(z) && seen.add(z));
  if (distinct.length === 0) return formatTimestamp(iso);
  const primary = formatTimestamp(iso, distinct[0]);
  if (distinct.length === 1) return primary;

  // The others carry the clock and the zone, not the date again: a second full
  // date invites reading it as a second event.
  const rest = distinct.slice(1)
    .map(z => shortClock(iso, z))
    .filter(Boolean);
  return rest.length ? `${primary} (${rest.join(", ")})` : primary;
}

/** Just the time and its zone: "7:30 AM PDT". */
function shortClock(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
    }).formatToParts(d);
    const at = (t: string) => parts.find(p => p.type === t)?.value ?? "";
    return `${at("hour")}:${at("minute")} ${at("dayPeriod").toUpperCase()} ${at("timeZoneName")}`.trim();
  } catch {
    return "";
  }
}

export interface BuiltMessage { subject: string; body: string; }

export function buildMessage(
  subjectTemplate: string,
  bodyTemplate: string,
  vars: Record<string, string | number | undefined>,
): BuiltMessage {
  return {
    subject: sanitizeSubject(render(subjectTemplate, vars)),
    body: render(bodyTemplate, vars),
  };
}
