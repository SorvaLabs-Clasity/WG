import fs from "node:fs";

/**
 * Regression test: the tabs that are restricted, and the ones deliberately not.
 *
 * A gate that lives only in the router is decoration. Anybody can call the API
 * directly, so the claim "this screen is restricted" is true only if the server
 * refuses — and the failure mode is silent, because the screen looks locked
 * either way.
 *
 * The opposite mistake is just as bad and easier to make: gating a route that
 * something unrestricted depends on. The personal board runs the same checks as
 * the Overview, so gating the check engine would take My work away from exactly
 * the people it was built for.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const read = (f: string) => fs.readFileSync(`./src/${f}`, "utf8");
const gate = read("middleware/teamGate.ts");

(async () => {
  console.log("\nthe gate refuses and explains, rather than just refusing");
  {
    check("a refusal carries a code the client can act on",
      /code,/.test(gate) && /CONTROL_HUB_ADMIN_REQUIRED/.test(gate) && /AWS_ADMIN_REQUIRED/.test(gate));
    check("  and names the team that would admit them",
      /team,/.test(gate) && /\$\{team\}/.test(gate),
      "without the team name there is nothing for somebody to do about it");

    // The distinction that matters when GitHub is unreachable: 403 tells
    // somebody they lost access they still have.
    check("  a failed membership check is an outage, not a refusal",
      /\.catch\(\(\) => res\.status\(503\)/.test(gate));
  }

  console.log("\nAccess is restricted on the server, not only in the router");
  {
    const access = read("routes/access.ts");
    check("every route on the tab is behind the gate",
      /router\.use\(requireControlHubAdmin\)/.test(access));
    // The comment that said the opposite sat there while the code changed.
    check("  and it no longer claims to be open to anyone signed in",
      !/Open to anyone signed in/.test(access),
      "a docblock contradicting the code is worse than none");
  }

  console.log("\nthe AWS tab is restricted to the AWS team, not the Control Hub one");
  {
    const aws = read("routes/awsGuardrails.ts");
    check("reads are gated too, not only the writes",
      /router\.use\(requireAwsAdmin\)/.test(aws));
    check("  on the AWS team", /requireAwsAdmin/.test(aws) && !/requireControlHubAdmin/.test(aws),
      "the two teams are different people: one runs the repos, one runs the account");
    check("  and the stale 'reading is open' note is gone",
      !/Reading is deliberately open/.test(aws));
  }

  console.log("\nthe Overview board is restricted; your own cards are not");
  {
    const widgets = read("routes/widgets.ts");
    // Gating this whole route would take the personal board with it.
    check("the shared list is gated",
      /if \(!mine && !\(await isControlHubAdmin/.test(widgets));
    check("  while a personal scope is not",
      /const mine = req\.query\.scope === "personal";/.test(widgets),
      "gating both would remove My work from everybody it is for");

    // Snapshots hold the checks' actual findings, so serving all of them past a
    // gated board hands over exactly what the gate was for.
    check("  stored answers are narrowed rather than refused",
      /res\.json\(all\.filter\(snap => mine\.has\(snap\.widgetId\)\)\)/.test(widgets));
    check("    with an admin still seeing every one",
      /if \(await isControlHubAdmin[\s\S]{0,120}return res\.json\(all\);/.test(widgets));
  }

  console.log("\nan alarm belongs to the team that owns what it watches");
  {
    const alarms = read("routes/alarms.ts");

    // The mismatch this fixes: guardrail alarms were gated on the Control Hub
    // team, so whoever administers the AWS account could not touch the alarms
    // watching it, while whoever administers only the repositories could —
    // including after the AWS tab itself was restricted to the AWS team.
    check("the subject decides which team may write",
      /const aws = subjectId\.startsWith\(GUARDRAIL_PREFIX\);/.test(alarms));
    check("  read from the stored subject, not from the request",
      /refusedForSubject\(req, res, existing\.widgetId\)/.test(alarms),
      "taking the team from the body would let either team claim the other's");

    for (const [route, anchor] of [
      ["create", "if (await refusedForSubject(req, res, String(widgetId))) return;"],
      ["edit", "if (await refusedForSubject(req, res, existing.widgetId)) return;"],
    ] as const) {
      check(`  ${route} is gated by subject`, alarms.includes(anchor));
    }
    check("  and so is delete",
      (alarms.match(/refusedForSubject\(req, res, existing\.widgetId\)/g) ?? []).length === 2,
      "edit and delete both act on a stored alarm, and both must ask");

    // Being unable to reach GitHub is an outage. Refusing would tell somebody
    // they had lost a permission they still hold.
    check("  an unanswerable membership check is a 503, not a refusal",
      /if \(allowed === null\) \{[\s\S]{0,120}503/.test(alarms));

    // Reading has to be open to both, or somebody is given the right to change
    // something they cannot find.
    check("either team can read the tab", /router\.use\(requireEitherTeam\);/.test(alarms));

    // Adding an address to a group is the "this app can email anyone"
    // capability, and one set of destinations serves the whole organization.
    for (const shared of [
      'router.post("/groups", requireAdmin',
      'router.post("/groups/:id/members", requireAdmin',
      'router.put("/teams-flow", requireAdmin',
      'router.put("/security", requireAdmin',
    ]) {
      check(`  ${shared.split('"')[1]} stays with the Control Hub team`,
        alarms.includes(shared), shared);
    }
  }

  console.log("\nthe alarms page shows both halves, and says which is yours");
  {
    const page = fs.readFileSync("../frontend/src/pages/AlarmsPage.tsx", "utf8");

    // It gated reading on the AWS team alone, so somebody who administers every
    // GitHub setting in this app opened the tab and was told it was for admins.
    check("both teams can open the page",
      /const isAdmin = canSeeGithub \|\| canSeeAws;/.test(page));
    check("  the two kinds are separate sections, not separate tabs",
      /const githubRows = useMemo/.test(page) && /const awsRows = useMemo/.test(page)
        && !/setLens\("aws"\)/.test(page));
    check("  a section somebody cannot change says so once, at the top",
      /view only ·/.test(page));
    check("  and its rows carry no controls",
      /\{canEdit && \(/.test(page),
      "a button that only ever returns a permission error is worse than none");
  }

  console.log("\nthe check engine stays open, deliberately");
  {
    const graph = read("routes/graph.ts");
    check("running a check is not gated at the router",
      !/router\.use\(require/.test(graph),
      "personal widgets run these, and a non-admin can build the same check anyway");
  }

  console.log("\nwhat the screen does is presentation; the server is the gate");
  {
    const ui = fs.readFileSync("../frontend/src/components/RequireTeam.tsx", "utf8");
    check("the locked screen names the team to ask for", /\{team\}/.test(ui));
    check("  and does not lock somebody out when GitHub cannot be reached",
      /if \(isError \|\| !perms\) return <>\{children\}<\/>;/.test(ui),
      "an outage must not read as a permission change");

    const router = fs.readFileSync("../frontend/src/router.tsx", "utf8");
    for (const [path, team] of [
      ["/analytics", "control-hub"], ["/access", "control-hub"], ["/aws", "aws"],
    ] as const) {
      const at = router.indexOf(`path: "${path}"`);
      const block = router.slice(at, at + 320);
      check(`  ${path} is wrapped for the ${team} team`,
        new RegExp(`RequireTeam team="${team}"`).test(block), block.slice(0, 120));
    }

    // Opening the app on a locked door is a poor first impression of a screen
    // working exactly as intended.
    check("  and the app opens somewhere the person can actually read",
      /isControlHubAdmin \? "\/analytics" : "\/my-work"/.test(router));
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
