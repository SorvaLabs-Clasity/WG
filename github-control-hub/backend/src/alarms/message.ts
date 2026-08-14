/**
 * Turning an alarm into the email that gets sent.
 *
 * Pure string work, kept away from the SNS client so the awkward parts — the
 * subject rules in particular — can be tested without publishing anything.
 */

/** Every variable a template may use, with what it means. The UI lists these. */
export const TEMPLATE_VARIABLES: { name: string; description: string }[] = [
  { name: "widget", description: "The widget's title" },
  { name: "metric", description: "What was measured, e.g. \"Critical alerts\"" },
  { name: "value", description: "The reading that fired this" },
  { name: "threshold", description: "The limit you set" },
  { name: "state", description: "ALARM or OK" },
  { name: "severity", description: "For security alerts: critical, high, medium, low" },
  { name: "repo", description: "For security alerts: the repository involved" },
  { name: "message", description: "For security alerts: what happened" },
  { name: "org", description: "The GitHub organization" },
  { name: "time", description: "When the value was observed (UTC)" },
];

const VARIABLE_NAMES = new Set(TEMPLATE_VARIABLES.map(v => v.name));

/**
 * Substitute {{name}} placeholders.
 *
 * An unknown name is left exactly as written rather than blanked. A template
 * reading "{{critical}} found" would otherwise send " found", which looks like
 * a bug in the alarm rather than a typo in the template — and the typo is
 * reported separately at save time by unknownVariables() below, which is when
 * somebody can still fix it.
 */
export function render(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (!VARIABLE_NAMES.has(name)) return whole;
    const v = vars[name];
    return v === undefined || v === null ? "" : String(v);
  });
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

export const DEFAULT_SECURITY_SUBJECT = "[{{severity}}] {{repo}}: {{message}}";
export const DEFAULT_SECURITY_BODY =
  `{{message}}\n\nRepository: {{repo}}\nSeverity: {{severity}}\n` +
  `Organization: {{org}}\nDetected at: {{time}}\n\n` +
  `This is an automated message from GitHub Control Hub.`;

/**
 * A timestamp a person can read, and cannot misread.
 *
 * {{time}} used to render the raw ISO string. It is correct, but it is UTC —
 * so to anyone not on UTC it looks like the alarm fired hours in the future or
 * the past, and the only thing saying otherwise is a trailing "Z" that is easy
 * to miss among the milliseconds.
 *
 * UTC is still the value sent, because one email reaches a group who may be in
 * several places and a single canonical zone is the only one that means the
 * same thing to all of them. It just says so now.
 */
export function formatTimestamp(iso: string | undefined, timeZone = "UTC"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);

  try {
    // en-CA for the year-month-day ordering, and timeZoneName so the reader is
    // never left guessing which clock this is.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
    }).formatToParts(d);
    const at = (t: string) => parts.find(p => p.type === t)?.value ?? "";
    const zone = at("timeZoneName");
    return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")}` +
           (zone ? ` ${zone}` : "");
  } catch {
    // An unknown zone name throws rather than falling back, and a rejected
    // timestamp would take the whole email with it. UTC is always valid.
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
           `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
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
