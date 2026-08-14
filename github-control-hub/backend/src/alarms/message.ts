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
  { name: "org", description: "The GitHub organisation" },
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
  `Organisation: {{org}}\nObserved at: {{time}}\n\n` +
  `This is an automated message from GitHub Control Hub.`;

export const DEFAULT_SECURITY_SUBJECT = "[{{severity}}] {{repo}}: {{message}}";
export const DEFAULT_SECURITY_BODY =
  `{{message}}\n\nRepository: {{repo}}\nSeverity: {{severity}}\n` +
  `Organisation: {{org}}\nDetected at: {{time}}\n\n` +
  `This is an automated message from GitHub Control Hub.`;

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
