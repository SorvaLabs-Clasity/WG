/**
 * Finding, reading and sanity-checking `~/.aws/config`.
 *
 * This was three separate answers to the same question. The profile list and
 * the profile writer each built `os.homedir() + "/.aws/config"` themselves,
 * while `regionOfProfile` honoured `AWS_CONFIG_FILE` — so on a machine where
 * that variable is set (managed Windows fleets set it, and so does anyone who
 * keeps work and personal credentials apart) the app listed profiles from a
 * file the CLI does not read, and *wrote* new ones into it. The profile then
 * existed, the screen said so, and `aws sso login --profile <it>` could not
 * find it.
 *
 * Everything that touches those files goes through here, so there is one
 * answer to "which file" and one answer to "what is in it".
 *
 * ## Why the encoding matters
 *
 * `fs.readFileSync(p, "utf-8")` on a UTF-16 file returns mojibake rather than
 * throwing: every character comes back interleaved with NUL, no section header
 * matches, and the honest report is "this machine has no profiles". That is
 * not a hypothetical. PowerShell's `>` redirection and `Set-Content` without
 * `-Encoding` both write UTF-16LE on Windows PowerShell 5.1, which is what is
 * still installed by default — so a config assembled with a one-line
 * PowerShell command is UTF-16, is invisible to this app, and is also
 * unreadable to the AWS CLI itself, which reports it as
 *
 *     Unable to parse config file: C:\Users\<name>/.aws/config
 *
 * Decoding by BOM costs four bytes of inspection and turns that whole class of
 * report into a file that simply works.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** How the file was stored, so that writing back does not change it. */
export type IniEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be";

export interface IniFile {
  /** The decoded text, with any byte-order mark removed. */
  text: string;
  encoding: IniEncoding;
  /** What the file uses to end a line, so an appended block matches. */
  eol: "\n" | "\r\n";
}

/**
 * `~` as the shells and the AWS CLI expand it.
 *
 * botocore expands its default `~/.aws/config` with `os.path.expanduser`, which
 * is why the CLI's own error messages on Windows read `C:\Users\x/.aws/config`
 * — a mixed path that is correct and resolves. Worth knowing, because it looks
 * like the bug and is not one.
 */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * The config file this machine's AWS tooling actually reads.
 *
 * `AWS_CONFIG_FILE` first, because that is the order every AWS SDK and the CLI
 * resolve it in. Reading a different file than the CLI reads is the failure
 * this exists to prevent.
 */
export function configFilePath(): string {
  const override = process.env.AWS_CONFIG_FILE?.trim();
  if (override) return expandHome(override);
  return path.join(os.homedir(), ".aws", "config");
}

/** The same rule for the credentials file. */
export function credentialsFilePath(): string {
  const override = process.env.AWS_SHARED_CREDENTIALS_FILE?.trim();
  if (override) return expandHome(override);
  return path.join(os.homedir(), ".aws", "credentials");
}

/**
 * Read an AWS ini file, whatever it was written in.
 *
 * Returns null when there is no file, which is an ordinary state — a machine
 * that has never run the CLI — and distinct from a file that cannot be read,
 * which throws so the caller can say so rather than reporting emptiness.
 */
export function readIniFile(file: string): IniFile | null {
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);

  let encoding: IniEncoding = "utf8";
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = "utf16le";
    text = buf.subarray(2).toString("utf16le");
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Node cannot decode big-endian directly; swap the pairs and reuse utf16le.
    encoding = "utf16be";
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    encoding = "utf8-bom";
    text = buf.subarray(3).toString("utf8");
  } else {
    text = buf.toString("utf8");
  }

  return { text, encoding, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

export interface AwsProfileInfo {
  name: string;
  type: "sso" | "iam" | "static";
  accountId?: string;
  roleName?: string;
  region?: string;
  ssoStartUrl?: string;
}

/** A comment, in both spellings the ini format allows. */
const isComment = (line: string) => line.startsWith("#") || line.startsWith(";");

/**
 * Every profile the file defines.
 *
 * Section headers are matched after trimming, which is what makes this safe on
 * CRLF files; the `\r` left by splitting on "\n" is whitespace and goes with
 * the trim.
 *
 * `sso-session` blocks are collected in a first pass because a profile may name
 * a session declared further down the file, and the start URL lives on the
 * session rather than on the profile in the modern form.
 */
export function parseProfiles(text: string): AwsProfileInfo[] {
  const lines = text.split("\n");
  const sessions = new Map<string, { startUrl?: string }>();

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^\[sso-session\s+(.+)]$/);
    if (!match) continue;
    const entry: { startUrl?: string } = {};
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (l.startsWith("[")) break;
      const [k, ...v] = l.split("=");
      if (k?.trim() === "sso_start_url") entry.startUrl = v.join("=").trim();
    }
    sessions.set(match[1].trim(), entry);
  }

  const profiles: AwsProfileInfo[] = [];
  const seen = new Set<string>();
  let current: AwsProfileInfo | null = null;
  const flush = () => {
    if (current && !seen.has(current.name)) { profiles.push(current); seen.add(current.name); }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[profile\s+(.+)]$/) || trimmed.match(/^\[(default)]$/);
    if (header) {
      flush();
      current = { name: header[1].trim(), type: "iam" };
      continue;
    }
    // Any other section ends the profile. Without this, keys in an
    // `[sso-session]` that follows a profile are read as that profile's.
    if (trimmed.startsWith("[")) { flush(); current = null; continue; }
    if (!current || isComment(trimmed)) continue;

    const [key, ...val] = trimmed.split("=");
    const k = key?.trim();
    const v = val.join("=").trim();
    if (k === "sso_account_id") { current.accountId = v; current.type = "sso"; }
    if (k === "sso_role_name") current.roleName = v;
    if (k === "region") current.region = v;
    if (k === "sso_start_url") { current.ssoStartUrl = v; current.type = "sso"; }
    if (k === "sso_session") {
      current.type = "sso";
      const session = sessions.get(v);
      if (session?.startUrl) current.ssoStartUrl = session.startUrl;
    }
  }
  flush();
  return profiles;
}

/** Section names, in file order, for the duplicate check below. */
function sectionNames(text: string): string[] {
  return text.split("\n")
    .map(l => l.trim().match(/^\[(.+)]$/)?.[1]?.trim())
    .filter((s): s is string => !!s);
}

export interface IniProblem {
  /** 1-based, so it matches what an editor shows. */
  line: number;
  text: string;
  why: string;
}

/**
 * Whether the AWS CLI will be able to parse this file.
 *
 * Deliberately mirrors Python's `configparser`, which is what the CLI uses and
 * which is stricter than the forgiving scan `parseProfiles` does: it raises on
 * a key before any section, on a line that is neither a header nor a
 * `key = value`, and on a repeated section name. Our reader shrugs those off
 * and reports whatever it did understand, so a file can list profiles here and
 * still be unusable from a terminal.
 *
 * This exists so that the app never *appends to* such a file. Adding a correct
 * profile to a file nothing can read produces the worst report of all: the
 * screen says the profile was created, and `aws sso login --profile <it>`
 * answers that it cannot parse the config — which sounds like the app wrote
 * something invalid, when what it wrote is fine and what was already there is
 * not.
 */
export function findIniProblems(text: string): IniProblem[] {
  const problems: IniProblem[] = [];
  const lines = text.split("\n");
  let inSection = false;

  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || isComment(trimmed)) return;

    if (trimmed.startsWith("[")) {
      if (!/^\[[^\]]+]$/.test(trimmed)) {
        problems.push({ line: i + 1, text: trimmed, why: "a section header with no closing ]" });
        return;
      }
      inSection = true;
      return;
    }

    // A continuation line: configparser allows an indented line to extend the
    // previous value, so an indented key is not on its own an error.
    if (/^\s/.test(line) && inSection) return;

    if (!inSection) {
      problems.push({ line: i + 1, text: trimmed, why: "a setting before any [section]" });
      return;
    }
    if (!/[=:]/.test(trimmed)) {
      problems.push({ line: i + 1, text: trimmed, why: "neither a [section] nor a key = value" });
    }
  });

  const names = sectionNames(text);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  for (const d of [...new Set(dupes)]) {
    problems.push({ line: 0, text: `[${d}]`, why: "the same section declared twice" });
  }

  return problems;
}

/**
 * The sentence to show somebody whose config file cannot be parsed.
 *
 * Names the file, the line and the reason, because "unable to parse config
 * file" with a path is precisely the message that leaves somebody stuck.
 */
export function describeProblems(file: string, encoding: IniEncoding, problems: IniProblem[]): string {
  if (encoding === "utf16le" || encoding === "utf16be") {
    return `${file} is saved as UTF-16, which the AWS CLI cannot read — it reports it as `
      + `"Unable to parse config file". PowerShell's ">" and Set-Content write UTF-16 by default. `
      + `Re-save it as UTF-8: `
      + `Get-Content "${file}" | Set-Content -Encoding utf8 "${file}.fixed", then replace the original.`;
  }
  const first = problems[0];
  if (!first) return `${file} could not be parsed.`;
  const where = first.line > 0 ? ` at line ${first.line}` : "";
  return `${file} has ${first.why}${where}: "${first.text}". `
    + `The AWS CLI refuses the whole file for this, which is why no profile in it works.`;
}
