import fs from "fs";
import os from "os";
import path from "path";

/**
 * The handful of choices the desktop app should not make you repeat.
 *
 * Which AWS profile you signed in with lived only in process.env, and closing
 * the app takes the embedded backend with it. So every launch fell back to
 * "default" — which for anyone whose profile is not called default meant
 * picking from a dropdown again, every time, forever.
 *
 * Deliberately not in DynamoDB: this is a preference belonging to one person on
 * one machine, and it has to be readable before AWS is connected, which is the
 * whole problem it solves.
 *
 * Nothing secret goes in here. A profile name is the name of a section in a
 * config file the user already has; the credentials stay where the AWS CLI puts
 * them.
 */

const DIR = path.join(os.homedir(), ".github-control-hub");
const FILE = path.join(DIR, "desktop.json");

export interface DesktopPrefs {
  /** Last AWS profile that successfully connected. */
  awsProfile?: string;
}

export function readDesktopPrefs(): DesktopPrefs {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as DesktopPrefs;
  } catch {
    // Missing, unreadable or corrupt all mean the same thing here: no
    // preference yet. A convenience file must never be able to stop the app.
    return {};
  }
}

export function writeDesktopPrefs(update: Partial<DesktopPrefs>): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const next = { ...readDesktopPrefs(), ...update };
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    // Same reasoning: failing to remember a dropdown choice is not a reason to
    // fail the sign-in that just succeeded.
  }
}

/**
 * Restore the remembered profile, once, at startup.
 *
 * Only when nothing else has already said which profile to use — an explicit
 * AWS_PROFILE in the environment is someone being deliberate, and a remembered
 * click should not override that.
 *
 * Returns the profile only when this call is what set it. A profile that was
 * already in the environment was not restored by anything, and a caller
 * logging "using remembered profile" for it would be describing a file it
 * never read.
 */
export function restoreAwsProfile(): string | undefined {
  if (process.env.__SERVER_MODE__) return undefined;   // EC2 uses the instance role
  if (process.env.AWS_PROFILE) return undefined;       // already chosen, deliberately

  const { awsProfile } = readDesktopPrefs();
  if (awsProfile) process.env.AWS_PROFILE = awsProfile;
  return awsProfile;
}

/** Remember a profile that actually worked. Never one that merely got typed. */
export function rememberAwsProfile(profile: string): void {
  writeDesktopPrefs({ awsProfile: profile });
}

export function forgetAwsProfile(): void {
  writeDesktopPrefs({ awsProfile: undefined });
}
