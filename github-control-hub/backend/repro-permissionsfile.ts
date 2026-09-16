/**
 * The permissions file: whether it can be used, and what is wrong when it cannot.
 *
 * Stage 1's engine is pure and assumes a well-formed file. This is the gate that
 * makes that assumption safe. A file that fails here grants nobody anything,
 * which is the whole of "fail closed" — so the difference between *fatal* and
 * *tolerated* is the most load-bearing judgement in this module.
 *
 * Run:  npx tsx repro-permissionsfile.ts   from github-control-hub/backend
 */
import { fileProblems, unknownNodesIn, isUsable } from "./src/permissions/validate";
import type { PermissionsFile } from "./src/permissions/types";
import fs from "node:fs";
import { emptyFile } from "./src/permissions/types";
import {
  decodeFileContent, isFailure, forgetPermissions, commitMessageFor, loadPermissions,
} from "./src/permissions/store";
import { forgetSubjects, subjectFor } from "./src/permissions/subject";
import { PERMISSIONS } from "./src/permissions/vocabulary";
import { accessForSelf, accessForOther } from "./src/permissions/index";
import { setPermissionsTestHooks } from "./src/permissions/testing";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const good: PermissionsFile = {
  version: 1,
  presets: { engineer: { name: "Engineer", grant: ["me", "activity.read.own"] } },
  teams: { platform: { presets: ["engineer"] } },
  people: { someone: { presets: ["engineer"], grant: ["config.export"] } },
};

console.log("a usable file");
{
  check("a good file has no problems", fileProblems(good).length === 0, fileProblems(good));
  check("  and is usable", isUsable(good));
}

console.log("\nshapes that are not a permissions file at all");
{
  for (const [name, raw] of [
    ["null", null], ["a string", "nope"], ["an array", []], ["a number", 7],
  ] as const) {
    check(`  ${name} is refused`, fileProblems(raw).length > 0 && !isUsable(raw));
  }
  check("a missing version is refused",
    fileProblems({ presets: {}, teams: {}, people: {} }).some(p => /version/.test(p.what)));
  check("a non-object presets map is refused",
    fileProblems({ version: 1, presets: [], teams: {}, people: {} }).some(p => /presets/.test(p.where)));
  // Absent sections are tolerated: an empty file is a valid file that grants
  // nothing, and refusing it would make the very first save impossible.
  check("absent sections are tolerated as empty",
    fileProblems({ version: 1 }).length === 0);
}

console.log("\nthings that make a file unusable");
{
  /**
   * The finding stage 1 deferred here: resolvePreset returns the rules it
   * gathered below a missing ancestor, so an unknown `inherits` would grant a
   * subset rather than failing. The gate is this validator, and it is why
   * nothing may evaluate a file that has not passed it.
   */
  const dangling = { version: 1, presets: { a: { name: "A", inherits: "ghost" } }, teams: {}, people: {} };
  check("a preset inheriting something that does not exist is fatal",
    fileProblems(dangling).some(p => /ghost/.test(p.what)), fileProblems(dangling));

  const cyclic = { version: 1,
    presets: { a: { name: "A", inherits: "b" }, b: { name: "B", inherits: "a" } },
    teams: {}, people: {} };
  check("a preset cycle is fatal", fileProblems(cyclic).some(p => /cycle/i.test(p.what)));

  const badRef = { version: 1, presets: {}, teams: {},
    people: { someone: { presets: ["no-such-preset"] } } };
  check("a person assigned a preset that does not exist is fatal",
    fileProblems(badRef).some(p => /no-such-preset/.test(p.what)), fileProblems(badRef));

  const badTeamRef = { version: 1, presets: {},
    teams: { platform: { presets: ["no-such-preset"] } }, people: {} };
  check("  and so is a team assigned one", fileProblems(badTeamRef).length > 0);

  check("a preset with no name is fatal",
    fileProblems({ version: 1, presets: { a: {} }, teams: {}, people: {} }).length > 0);
}

console.log("\nthings that are tolerated and reported");
{
  /**
   * An app upgrade that removes a permission must not lock the organization
   * out of the screen that would fix it. So an unknown node is ignored at
   * evaluation time — stage 1's decideLeaf already skips it — and named here
   * so the admin screen can offer to clean it up.
   */
  const stale: PermissionsFile = { version: 1, presets: {}, teams: {},
    people: { someone: { grant: ["alarms.org.create", "alarms.removedLastYear"] } } };
  check("an unknown node does not make a file unusable",
    fileProblems(stale).length === 0 && isUsable(stale));
  check("  but it is reported",
    unknownNodesIn(stale).includes("alarms.removedLastYear"), unknownNodesIn(stale));
  check("  and a known one is not",
    !unknownNodesIn(stale).includes("alarms.org.create"));
  check("  branches count as known",
    unknownNodesIn({ version: 1, presets: {}, teams: {},
      people: { x: { grant: ["alarms"] } } }).length === 0);
  check("  and nodes inside presets and teams are reported too",
    unknownNodesIn({ version: 1,
      presets: { p: { name: "P", grant: ["made.up.one"] } },
      teams: { t: { revoke: ["also.made.up"] } }, people: {} },
    ).sort().join() === "also.made.up,made.up.one");
  check("  each unknown node reported once",
    unknownNodesIn({ version: 1, presets: {}, teams: {},
      people: { a: { grant: ["ghost.node"] }, b: { grant: ["ghost.node"] } } }).length === 1);
}

console.log("\nevery problem says where it is");
{
  const p = fileProblems({ version: 1, presets: { a: { name: "A", inherits: "ghost" } }, teams: {}, people: {} });
  check("a problem names its location", p.every(x => x.where.length > 0), p);
  check("  and what is wrong", p.every(x => x.what.length > 0));
}

console.log("\nreading the file");
{
  // Decoding is the only part of the reader that is pure enough to test
  // directly; the rest needs GitHub and is exercised by the route tests in
  // stage 3. Base64 with embedded newlines is what the contents API returns.
  check("base64 content is decoded, newlines and all",
    decodeFileContent(Buffer.from('{"version":1}', "utf8").toString("base64")) === '{"version":1}');
  const wrapped = Buffer.from('{"version":1}', "utf8").toString("base64").match(/.{1,4}/g)!.join("\n");
  check("  and GitHub's line-wrapped base64 too",
    decodeFileContent(wrapped) === '{"version":1}');

  check("a failure is distinguishable from a load",
    isFailure({ reason: "unreachable", detail: "x" })
    && !isFailure({ file: emptyFile(), sha: null, source: "absent" }));

  // The decision that must not soften: a failure yields nothing, never a
  // remembered copy. A cached grant is a grant nobody can revoke.
  const store = fs.readFileSync("./src/permissions/store.ts", "utf8");
  check("nothing keeps a last-known-good copy",
    !/lastKnownGood|lastGood|fallbackFile/.test(store),
    "a cached grant outlives the file that granted it");
  check("  and the cache is cleared rather than served on failure",
    /forgetPermissions/.test(store));
}

console.log("\nfileProblems is total: it reports, it never throws");
{
  /**
   * `fileProblems` runs on arbitrary parsed JSON — somebody's hand-edit —
   * and `store.ts` gates every request on it. A throw here is not "a
   * rejection with extra steps": the caller treats a throw differently from
   * a returned list of problems, so a throw is a fail-*OPEN* path. Every
   * shape below used to crash `presetProblems` reaching into a `null` entry
   * that `validate.ts` had reported but not removed.
   */
  const safely = (raw: unknown) => {
    try {
      return { threw: false, problems: fileProblems(raw) };
    } catch (e) {
      return { threw: true, problems: [] as ReturnType<typeof fileProblems> };
    }
  };

  const cases: Array<[string, unknown]> = [
    ["a null preset", { version: 1, presets: { a: null }, teams: {}, people: {} }],
    ["a preset that is a string", { version: 1, presets: { a: "text" }, teams: {}, people: {} }],
    ["a null team", { version: 1, presets: {}, teams: { t: null }, people: {} }],
    ["a null person", { version: 1, presets: {}, teams: {}, people: { p: null } }],
  ];
  for (const [name, raw] of cases) {
    const result = safely(raw);
    check(`  ${name} does not throw`, !result.threw);
    check(`    and is reported as a problem`, result.problems.length > 0, result.problems);
  }
}

console.log("\na malformed presets assignment is a problem, not a silent no-op");
{
  // `presets: "engineer"` is not an array. Reading "not an array" as "no
  // presets assigned" makes a broken assignment look unused rather than
  // broken, and grants nothing where the file asked for something.
  const malformed = { version: 1, presets: {}, teams: {},
    people: { p: { presets: "engineer" } } };
  check("a person with a non-array presets value is not usable", !isUsable(malformed));
  check("  and the problem names the person",
    fileProblems(malformed).some(p => p.where === "people.p"), fileProblems(malformed));

  // Absent is still fine — this is what the earlier behaviour must not
  // regress.
  const absent = { version: 1, presets: {}, teams: {}, people: { p: { grant: ["me"] } } };
  check("  while a person with no presets at all is still usable", isUsable(absent));
}

console.log("\na preset with no name is reported once, not twice");
{
  // `validate.ts` reports it at the specific `presets.<id>`; `presetProblems`
  // (stage 1's own checker) reports the same defect again at the coarser
  // `presets`, because it has no per-id location. One defect, one problem.
  const nameless = { version: 1, presets: { a: {} }, teams: {}, people: {} };
  const p = fileProblems(nameless);
  check("exactly one problem is reported for one nameless preset", p.length === 1, p);
  check("  and it is the specific one", p[0]?.where === "presets.a", p);
}

console.log("\nwriting the file");
{
  check("the commit message names the change and who made it",
    commitMessageFor("some-login", "Grant alarms.org.create to other-login")
      === "Grant alarms.org.create to other-login\n\nBy some-login via Control Hub",
    commitMessageFor("some-login", "Grant alarms.org.create to other-login"));

  const store = fs.readFileSync("./src/permissions/store.ts", "utf8");

  /**
   * Two administrators on the same screen must not silently discard each
   * other's work. The sha the editor loaded is sent back; a changed one means
   * somebody saved first, and the write is refused rather than applied.
   */
  check("the write sends the sha it read",
    /sha: sha \?\? undefined|sha:\s*sha/.test(store), "without it a concurrent save is lost");
  check("  and a 409 from GitHub is reported as a conflict",
    /409/.test(store) && /"conflict"/.test(store));

  // Writing a file that cannot be read back is how an admin locks the org out.
  check("a file that would not validate is refused before it is written",
    /isUsable\(next\)/.test(store) || /fileProblems\(next\)/.test(store));

  check("a successful write drops the cache",
    /forgetPermissions\(\)/.test(store.slice(store.indexOf("savePermissions"))),
    "otherwise a change you just made is invisible for up to a minute");
}

console.log("\nwho the caller is");
{
  const subject = fs.readFileSync("./src/permissions/subject.ts", "utf8");

  /**
   * The exemption that keeps a broken file from locking everybody out. It has
   * to be read from GitHub rather than from the permissions file, or the file
   * could revoke the exemption that exists to survive the file.
   */
  check("organization ownership is read from GitHub, not from the file",
    /getMembershipForUser\(/.test(subject) && /role === "admin"/.test(subject));
  check("  and never from the permissions file",
    !/loadPermissions|PermissionsFile/.test(subject));

  /**
   * The bug this shape exists to make impossible.
   *
   * `teams.listForAuthenticatedUser` is `GET /user/teams`. It takes no
   * username: it answers for whoever holds the token. So a bare `userToken`
   * parameter reads as "the token to ask with" while behaving as "the person
   * being asked about", and the caller that gets it wrong is not hypothetical
   * — the Admin tab's dry-run diff asks what somebody *else* would hold, with
   * its own operator's token in hand. That granted the operator's teams to
   * that person, and cached it under their login for a minute.
   */
  check("subjectFor takes an options object, not a bare token",
    /subjectFor\(login: string, opts\?: SubjectOptions/.test(subject));
  check("  whose name says whose token it must be",
    /ownToken\?: string/.test(subject));
  check("  and the source does not claim GitHub narrows that call by username",
    !/only membership that token can read/i.test(subject)
    && /takes no username/i.test(subject),
    "GET /user/teams answers for the token holder, whoever that is");

  /**
   * Two ways to resolve teams, because there are two questions.
   *
   * "What am I in" is one paginated call on the asker's own token — the
   * per-request path, and it has to stay O(1). "What is that person in" cannot
   * use that endpoint at all, so it costs one call per team on the App token,
   * which is only affordable because it is the rare administrative inspection.
   */
  check("a caller's own teams are read in one paginated call",
    /listForAuthenticatedUser/.test(subject));
  check("  paged the way the rest of this codebase pages",
    /per_page: 100/.test(subject) && /page\b/.test(subject));
  check("  while somebody else's are resolved by name, with the App token",
    /teams\.list\(\{ org/.test(subject) && /getMembershipForUserInOrg/.test(subject));
  check("  and that path says why O(teams) is acceptable there and nowhere else",
    /O\(teams\)/.test(subject) && /per-request/.test(subject));

  /**
   * And the two answers are kept apart. One inspection of somebody must not
   * overwrite the subject they resolved for themselves a moment earlier —
   * the App path is the weaker read, and they would spend the rest of the
   * minute holding less than they should.
   */
  check("the cache is keyed by login and by how the teams were resolved",
    /\$\{login\.toLowerCase\(\)\}:\$\{via\}/.test(subject)
    && /"self"/.test(subject) && /"app"/.test(subject));
  check("  and only an answer that was actually resolved is remembered",
    /teamsResolved/.test(subject) && /if \(teamsResolved\) cache\.set/.test(subject),
    "one tokenless internal call would otherwise leave that login with no teams");

  /**
   * The owner exemption has to survive a degraded GitHub, which is the
   * situation it exists for. `createOctokit` disables throttle retry, so a
   * rate-limited App token fails the file read and the ownership read
   * together — and the caller's own grant is a different allowance.
   */
  check("a failed ownership read is retried on the caller's own token",
    /readOwnership\(ownToken, org, login\)/.test(subject)
    && /answered/.test(subject));
  check("  and GitHub narrows that retry, because a username is passed",
    /getMembershipForUser\(\{ org, username: login \}\)/.test(subject));

  /**
   * Fail closed, the same rule as the file: an unreadable membership means the
   * person keeps only what their own entries and presets give them. Not a
   * fallback to a remembered list.
   */
  check("an unreadable membership yields no teams rather than the last known set",
    /catch/.test(subject) && !/lastKnownTeams|rememberedTeams\b/.test(subject));

  check("answers are cached, so a screen is not a burst of GitHub calls",
    /TTL|expires/.test(subject) && /forgetSubjects/.test(subject));

  // An unset GITHUB_ORG must not reject: a throw is a fail-OPEN path, because
  // the caller handles it somewhere other than where it handles a denial.
  check("getOrg is inside the try, so an unset organization is an answer",
    subject.indexOf("try {") < subject.indexOf("org = getOrg()"),
    "a throw is handled by different code from a denial");
}

console.log("\nwhere the file came from, and what to offer about it");
{
  const store = fs.readFileSync("./src/permissions/store.ts", "utf8");

  /**
   * A 404 from the contents API was three states wearing one hat: no
   * repository, no file, and an App that lost access to the repository. The
   * third read as `failure: null` with nobody granted anything and no error
   * anywhere — the worst shape a broken permission system can take.
   */
  check("a 404 is probed rather than assumed",
    /repos\.get\(\{ owner: getOrg\(\)/.test(store) && /probeRepository/.test(store));
  check("  a missing repository is named as one", /"no-repo"/.test(store));
  check("  a missing file is still the ordinary first run", /source: "absent"/.test(store));
  check("  and a probe that fails says the App may have lost access",
    /may have lost access/.test(store) && /reason: "unreachable"/.test(store));

  // The three shapes a caller has to tell apart, as values.
  const noRepo = { file: emptyFile(), sha: null, source: "no-repo" as const };
  const absent = { file: emptyFile(), sha: null, source: "absent" as const };
  const lost = { reason: "unreachable" as const, detail: "The App may have lost access." };
  check("the three states are distinguishable by the caller",
    !isFailure(noRepo) && !isFailure(absent) && isFailure(lost)
    && noRepo.source !== absent.source);

  check("the source and the sha reach the caller",
    /source: loaded\.source/.test(fs.readFileSync("./src/permissions/index.ts", "utf8"))
    && /sha: loaded\.sha/.test(fs.readFileSync("./src/permissions/index.ts", "utf8")));

  /**
   * A save that returns an empty sha disarms the next save's conflict check:
   * the write sends the sha only when it is truthy, and `""` is not.
   */
  check("a save with no sha in the response is a failure, not an empty sha",
    !/content\?\.sha \?\? ""/.test(store) && /returned no sha/.test(store));

  check("getOrg and the client are inside the try in the reader too",
    store.indexOf("try {") < store.indexOf("org = getOrg()"));
}

console.log("\nthe one question the app asks");
{
  const index = fs.readFileSync("./src/permissions/index.ts", "utf8");

  check("it composes the store, the subject and the engine",
    /loadPermissions/.test(index) && /subjectFor/.test(index) && /permissionsFor/.test(index));

  check("  and accessForSelf passes the caller's own token as their own",
    /subjectFor\(login, \{ ownToken \}\)/.test(index),
    "anything else attributes one person's teams to another");

  /**
   * The structural half of the fix: `accessForOther` cannot forward a token
   * it does not have. A doc comment saying "don't pass somebody else's
   * token" is a promise nothing enforces; a missing parameter is.
   */
  check("  while accessForOther declares exactly one parameter, so it has no token to misuse",
    /export async function accessForOther\(login: string\): Promise<Access> \{/.test(index),
    "a second parameter here would let a dry-run diff reuse the operator's token");

  /**
   * AWS-only installs have no GitHub organization and no repository to hold a
   * file, so the whole system is inert there and the app behaves as it does
   * today. Anything else would make an AWS deployment depend on a GitHub
   * feature it does not have.
   */
  check("an AWS-only install is inert rather than locked out",
    /aws-only/.test(index) && /inert/.test(index));
  check("  and inert is the same always-true set an owner holds",
    /allPermissions\("inert"/.test(index),
    "a second always-true object drifts from the first the next time a permission is added");

  /**
   * Every other failure is closed, not open. An owner still gets in, because
   * the engine exempts them and the subject is read from GitHub rather than
   * from the file that just failed to load.
   */
  check("every other failure grants an empty file, not a bypass",
    /emptyFile\(\)/.test(index));
  check("  and the reason travels with it, for the screen to show",
    /failure/.test(index));

  check("unknown nodes are surfaced rather than swallowed",
    /unknownNodesIn/.test(index));

  check("nothing below accessForSelf/accessForOther may reject",
    /} catch \(err: any\) \{/.test(index) && /reason: "unreachable"/.test(index));
}

(async () => {
  console.log("\nan AWS-only install is inert, which means every check passes");
  {
    /**
     * The spec says inert, and the gates are ~155 call sites in stage 3. A
     * permission set that answers `false` beside an `inert: true` flag is one
     * forgotten `|| inert` away from breaking every AWS install, and the
     * forgotten one is invisible until somebody with an AWS deployment says a
     * screen is empty.
     */
    const before = process.env.AWS_ONLY;
    process.env.AWS_ONLY = "true";
    forgetPermissions();
    forgetSubjects();

    const access = await accessForOther("anybody");
    check("it is flagged inert", access.inert === true, access.inert);
    check("  and says why", access.failure?.reason === "aws-only", access.failure);
    check("  and every check passes", access.permissions.has("admin.presets.delete")
      && access.permissions.has("aws.rules.delete") && access.permissions.has("me.work.read"));
    check("  including permissions this version has never heard of",
      access.permissions.has("invented.later"));
    check("  and the whole vocabulary is enumerable, for the admin screen",
      access.permissions.held.length === PERMISSIONS.length, access.permissions.held.length);
    check("  while saying it is inert rather than claiming an owner",
      access.permissions.explain("aws.rules.delete").reason === "inert",
      access.permissions.explain("aws.rules.delete"));

    if (before === undefined) delete process.env.AWS_ONLY; else process.env.AWS_ONLY = before;
    forgetPermissions();
  }

  console.log("\na failure is not cached like a success");
  {
    /**
     * Sixty seconds was wrong for a failure: somebody who repairs the file by
     * pushing to the repository would watch the app go on rejecting it, with
     * nothing on screen to say the fix had landed. Short enough to be a
     * stampede guard, not long enough to be a memory.
     */
    const before = process.env.AWS_ONLY;
    forgetPermissions();
    process.env.AWS_ONLY = "true";
    const first = await loadPermissions(0);
    process.env.AWS_ONLY = "false";
    const soon = await loadPermissions(3_000);
    const later = await loadPermissions(20_000);

    check("a failure is reused for a moment",
      isFailure(first) && isFailure(soon) && (soon as any).reason === "aws-only", soon);
    check("  and then re-read rather than remembered",
      isFailure(later) && (later as any).reason !== "aws-only", later);

    if (before === undefined) delete process.env.AWS_ONLY; else process.env.AWS_ONLY = before;
    forgetPermissions();
  }

  console.log("\nnothing rejects, whatever the environment is missing");
  {
    /**
     * `getOrg()` throws when GITHUB_ORG is unset. A rejected promise is a
     * fail-OPEN path: the caller handles it in the error middleware rather
     * than in the branch that denies, and a gate that is never reached is a
     * gate that never said no.
     */
    const org = process.env.GITHUB_ORG;
    const awsOnly = process.env.AWS_ONLY;
    delete process.env.GITHUB_ORG;
    delete process.env.AWS_ONLY;
    forgetPermissions();
    forgetSubjects();

    let rejected = false;
    let access: Awaited<ReturnType<typeof accessForSelf>> | null = null;
    try {
      access = await accessForSelf("anybody", "a-token-belonging-to-anybody");
    } catch {
      rejected = true;
    }
    check("accessForSelf does not reject when the organization is unset", !rejected);
    check("  it returns a closed answer instead",
      access !== null && access.permissions.held.length === 0, access?.permissions.held);
    check("  with a reason on it", access?.failure != null, access?.failure);

    const subject = await subjectFor("anybody");
    check("  and subjectFor answers nobody rather than throwing",
      subject.teamSlugs.length === 0 && subject.isOrgOwner === false, subject);

    if (org === undefined) delete process.env.GITHUB_ORG; else process.env.GITHUB_ORG = org;
    if (awsOnly === undefined) delete process.env.AWS_ONLY; else process.env.AWS_ONLY = awsOnly;
    forgetPermissions();
    forgetSubjects();
  }

  console.log("\nteams belong to the person they were read for");
  {
    /**
     * The Critical stage 2's review found, tested by behaviour rather than by
     * grepping the source. `teams.listForAuthenticatedUser` takes no username, so
     * an implementation that passes the wrong token attributes one person's teams
     * to another — and the old tests would have passed through that bug.
     *
     * Stage 3 found the same defect one level up: `accessFor(login, userToken)`
     * forwarded whatever token it was given as `ownToken`, unconditionally, with
     * the "must belong to login" rule stated only in a doc comment. Fixed
     * structurally instead: `accessForSelf` takes a token and is the only one
     * that can hand it to `subjectFor`; `accessForOther` takes no token
     * parameter at all, so there is nothing for it to misuse.
     */
    setPermissionsTestHooks({
      loadFile: () => ({ file: { version: 1, presets: {},
        teams: { admins: { grant: ["aws"] } }, people: {} }, sha: "x", source: "github" }),
      ownTeams: (token: string) => token === "admin-token" ? ["admins"] : [],
      teamsOf: (login: string) => login === "an-admin" ? ["admins"] : [],
      ownerOf: () => false,
    });

    const self = await accessForSelf("an-admin", "admin-token");
    check("your own token gives you your own teams", self.permissions.has("aws.rules.read"));

    // The bug: inspecting somebody else must go through a function that has no
    // token to lend them in the first place.
    const other = await accessForOther("somebody-else");
    check("inspecting somebody else does not lend them your teams",
      !other.permissions.has("aws.rules.read"),
      "an admin's teams were being attributed to whoever they inspected");

    // And the misattribution must not be cached against them either.
    const otherAgain = await accessForOther("somebody-else");
    check("  nor is it cached against them",
      !otherAgain.permissions.has("aws.rules.read"));

    // Not just that this test happens not to pass a token — the signature
    // itself accepts none, so no future caller can reintroduce the bug.
    const index = fs.readFileSync("./src/permissions/index.ts", "utf8");
    check("  and accessForOther's signature accepts no token to misuse",
      /export async function accessForOther\(login: string\): Promise<Access> \{/.test(index));

    setPermissionsTestHooks(null);
    forgetPermissions();
    forgetSubjects();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
