import type { PermissionsFile, Preset } from "./types";
import { emptyFile } from "./types";
import { permissionsFor, type Subject } from "./evaluate";
import { CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";

/**
 * The starting file, and the diff that proves it changes nothing.
 *
 * Deliberately pure: no GitHub, no filesystem, no environment. Everything this
 * needs — who is a member, who is on which legacy team, who owns the
 * organization — is read from GitHub by the caller and handed in as data, so
 * this can be exercised directly by `repro-admin.ts` without a network.
 *
 * **Deny by default means switching enforcement on is a cliff.** Everybody
 * loses everything the moment `PERMISSIONS_ENABLED` flips, unless the file
 * already names them. `startingFile` exists so the flip changes nothing on day
 * one — it reproduces today's team-based behaviour exactly, in presets rather
 * than as a per-person copy of it — and the narrowing that is the whole point
 * of this project happens afterwards, deliberately, one person at a time.
 */

export interface MemberSnapshot {
  login: string;
  isControlHubAdmin: boolean;
  isAwsAdmin: boolean;
  isOrgOwner: boolean;
}

/**
 * What a plain signed-in member can do today: every `me.*` leaf (nobody's
 * queue but their own), plus the reads that are open to anybody signed in.
 *
 * A branch grant ("me", "expertise", "org") is one string that survives the
 * vocabulary growing under it; the individual leaves below it are the ones
 * whose branch also holds a write today's plain member does not have, so the
 * branch itself cannot be granted without widening what "member" means.
 */
const MEMBER_GRANT = [
  "me",
  "activity.read.own",
  "activity.read.github",
  "repos.read",
  "repos.detail.read",
  "repos.blastRadius.read",
  "repos.query.read",
  "pulls.read",
  "deps.read",
  "expertise",
  "overview.read",
  "overview.cards.read",
  "org",
  "alarms.org.read",
];

/**
 * The three presets today's world reduces to: everybody, and the two legacy
 * teams. Each of the latter two inherits `member` rather than repeating it, so
 * a leaf added to what everybody can do widens all three at once.
 */
const PRESETS: Record<string, Preset> = {
  member: {
    name: "Member",
    description: "What every signed-in member of the organization can do today.",
    grant: MEMBER_GRANT,
  },
  "control-hub-admin": {
    name: "Control Hub Admin",
    description: "What today's control-hub-admins team unlocks, on top of member.",
    inherits: "member",
    grant: [
      "alarms", "scanners", "widgets", "access", "config", "activity", "pulls", "deps", "repos", "admin",
    ],
  },
  "aws-admin": {
    name: "AWS Admin",
    description: "What today's aws-guardrail-admins team unlocks, on top of member.",
    inherits: "member",
    grant: ["aws", "activity.detailedLogging"],
  },
};

function presetsFor(member: MemberSnapshot): string[] {
  const presets: string[] = [];
  if (member.isControlHubAdmin) presets.push("control-hub-admin");
  if (member.isAwsAdmin) presets.push("aws-admin");
  // Everybody holds at least `member` — including somebody on neither legacy
  // team, and an organization owner, who is exempt in the engine but is named
  // here anyway so the file is a complete picture rather than a list with
  // holes for the people it did not have to mention.
  if (presets.length === 0) presets.push("member");
  return presets;
}

/**
 * A fresh copy of the three presets, never the module-level object itself.
 *
 * `emptyFile()`'s docblock gives the reason and this function used to ignore
 * it: handing out a shared reference means one consumer that pushes a node
 * into `PRESETS.member.grant` widens what "member" means for every file the
 * process builds afterwards. `dryRun` below now builds one starting file per
 * member, so the shared reference would be handed out once per person per
 * dry-run rather than once per migration.
 */
function clonePresets(): Record<string, Preset> {
  const out: Record<string, Preset> = {};
  for (const [id, preset] of Object.entries(PRESETS)) {
    out[id] = {
      ...preset,
      ...(preset.grant ? { grant: [...preset.grant] } : {}),
      ...(preset.revoke ? { revoke: [...preset.revoke] } : {}),
    };
  }
  return out;
}

/**
 * A permissions file that reproduces today's access exactly: everybody named,
 * everybody holding the preset (or two) matching their current team
 * membership.
 */
export function startingFile(members: MemberSnapshot[]): PermissionsFile {
  const file = emptyFile();
  file.presets = clonePresets();
  for (const member of members) {
    /**
     * Control Hub admins get no entry. They hold every permission on the
     * strength of their team membership, so an entry naming one of them would
     * decide nothing — and the write path refuses such an entry precisely
     * because a restriction that cannot take effect reads, to whoever finds it
     * next, as one that has.
     *
     * Their access is unchanged by this: the dry-run reports them keeping
     * everything, because the exemption is what grants it.
     */
    if (member.isControlHubAdmin) continue;
    file.people[member.login.toLowerCase()] = { presets: presetsFor(member) };
  }
  return file;
}

export interface DryRunRow {
  login: string;
  /** Leaves this person holds today — under their *own* standing — but would not under `file`. */
  losing: string[];
  /** How many leaves this person would hold under `file`. */
  keeping: number;
  /** Exempt from every check in the engine; reported rather than implied. */
  isOrgOwner: boolean;
}

function subjectOf(member: MemberSnapshot): Subject {
  /**
   * The team slug has to be here, not just the flag.
   *
   * `permissionsFor` exempts Control Hub admins by looking for the slug in
   * `teamSlugs`, so a subject built without it evaluates an administrator as
   * though they were on no teams at all — reporting them holding nothing,
   * before *and* after, and therefore losing nothing. An operator reads a
   * clean row for the very people who hold the most.
   */
  return {
    login: member.login,
    teamSlugs: member.isControlHubAdmin ? [CONTROL_HUB_ADMIN_TEAM] : [],
    isOrgOwner: member.isOrgOwner,
  };
}

/**
 * For each member, what they would lose if `file` were the permissions file
 * enforcement used today.
 *
 * **The baseline is each person's own current standing, not a constant.** It
 * used to be the `member` preset for everybody, which made `losing`
 * structurally incapable of naming anything above plain-member level: no
 * `admin.*`, no `aws.*`, no `access.*`. A file that stripped every
 * administrator and every AWS operator of everything they hold reported a
 * clean dry-run, and `docs/operations/setup.md` makes that column the gate on
 * the whole flip — "anything in the 'would lose' column is a decision to make
 * *before* the flip". An operator reading an empty column turns enforcement on.
 *
 * `startingFile([member])` is exactly today's access for one person: the
 * presets their own `isControlHubAdmin` / `isAwsAdmin` standing earns them,
 * resolved by the same engine that will decide it after the flip. Comparing
 * against that is the comparison the screen claims to be making.
 *
 * An empty file loses everybody everything. `startingFile`'s whole purpose is
 * for this to report nothing lost for anybody — that is the proof the flip is
 * survivable, not merely an assertion that it is.
 */
export function dryRun(file: PermissionsFile, members: MemberSnapshot[]): DryRunRow[] {
  return members.map(member => {
    const subject = subjectOf(member);

    const baseline = permissionsFor(startingFile([member]), subject);
    const actual = permissionsFor(file, subject);

    const losing = baseline.held.filter(leaf => !actual.has(leaf));
    return { login: member.login, losing, keeping: actual.held.length, isOrgOwner: member.isOrgOwner };
  });
}
