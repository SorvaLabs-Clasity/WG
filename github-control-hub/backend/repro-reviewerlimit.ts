import fs from "node:fs";
import path from "node:path";
import { recipientsFor } from "./src/webhooks/devEvents";
import { withinReviewerLimit, buildEventCard } from "./src/services/devAlertContent";

/**
 * Regression test: "only tell me when the review is mine to do".
 *
 * Two ways to get this wrong, and both are silent. Withholding a review request
 * because a list could not be read leaves somebody waiting on a review they
 * were never told about. Counting the wrong things, a team as nobody or the
 * reader as somebody else, makes "only me" mean something the person did not
 * choose.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const prefs = (limit?: number) => ({
  teamsAddress: "me@work.com", reviewerLimit: limit,
  events: { reviewRequested: true, changesRequested: true },
} as any);

const payload = (reviewers: string[], teams: string[] = []) => ({
  action: "review_requested",
  sender: { login: "alice" },
  requested_reviewer: { login: "bob" },
  pull_request: {
    number: 7, title: "Fix it", html_url: "https://gh/pr/7", user: { login: "alice" },
    requested_reviewers: reviewers.map(login => ({ login })),
    requested_teams: teams.map(slug => ({ slug })),
  },
  repository: { name: "api" },
});

(async () => {
  console.log("\nthe list comes from the pull request, not from the event");
  {
    // The event names the one person just added; the pull request carries who
    // is still outstanding, which is what "am I the only one" needs.
    const [target] = recipientsFor("pull_request", payload(["bob", "carol"]));
    check("everybody still awaiting review is carried", !!target.reviewers, target);
    check("  with the reader's own name removed",
      !target.reviewers!.includes("bob"), target.reviewers);
    check("    leaving the others", target.reviewers!.includes("carol"), target.reviewers);
  }

  console.log("\nthe count is everybody, the reader included");
  {
    // "1" has to mean "nobody else", which is only true if the reader counts.
    const alone = recipientsFor("pull_request", payload(["bob"]))[0];
    check("only me passes a limit of one", withinReviewerLimit(prefs(1), alone), alone);

    const two = recipientsFor("pull_request", payload(["bob", "carol"]))[0];
    check("  me and one other does not", !withinReviewerLimit(prefs(1), two), two);
    check("    but passes a limit of two", withinReviewerLimit(prefs(2), two), two);

    const three = recipientsFor("pull_request", payload(["bob", "carol", "dan"]))[0];
    check("  three of us fails a limit of two", !withinReviewerLimit(prefs(2), three), three);
  }

  console.log("\na team counts as one, not as nobody");
  {
    // Treating a team as nobody would make a request to four teams look like a
    // request to one person, which is the opposite of what somebody choosing
    // "only me" is asking for.
    const withTeam = recipientsFor("pull_request", payload(["bob"], ["platform"]))[0];
    check("me plus a team fails a limit of one",
      !withinReviewerLimit(prefs(1), withTeam), withTeam);
    check("  and passes a limit of two", withinReviewerLimit(prefs(2), withTeam), withTeam);
  }

  console.log("\nit only ever narrows");
  {
    const many = recipientsFor("pull_request", payload(["bob", "carol", "dan", "erin"]))[0];
    check("no limit means every request", withinReviewerLimit(prefs(undefined), many));
    check("  and so does a nonsense one", withinReviewerLimit(prefs(0), many));

    // A payload with no reviewer list is notified rather than silently
    // withheld: the alternative is losing a review request to a number nobody
    // could see.
    const unreadable = { login: "bob", kind: "reviewRequested" as const };
    check("  a request whose list cannot be read is sent",
      withinReviewerLimit(prefs(1), unreadable as any), unreadable);
  }

  console.log("\nthe card says who else is on it");
  {
    const card = JSON.stringify(buildEventCard({
      kind: "reviewRequested", repo: "api", number: 7, title: "Fix it",
      url: "https://gh/pr/7", actor: "alice", reviewers: ["carol", "dan"],
    }));
    check("the other reviewers are named", card.includes("carol") && card.includes("dan"), card.slice(0, 200));

    const solo = JSON.stringify(buildEventCard({
      kind: "reviewRequested", repo: "api", number: 7, title: "Fix it",
      url: "https://gh/pr/7", actor: "alice", reviewers: [],
    }));
    // The most useful thing the card can say, and the reason somebody reads it
    // now rather than later.
    check("  and being the only one is said outright",
      solo.includes("only reviewer"), solo.slice(0, 200));

    const teamed = JSON.stringify(buildEventCard({
      kind: "reviewRequested", repo: "api", number: 7, title: "Fix it",
      url: "https://gh/pr/7", actor: "alice", reviewers: ["carol"], reviewerTeams: ["platform"],
    }));
    check("  a team is named as a team", teamed.includes("platform")
      && /1 team/.test(teamed), teamed.slice(0, 240));
  }

  console.log("\nthe skip happens where the preference is read");
  {
    const events = fs.readFileSync(path.join(__dirname, "src/webhooks/devEvents.ts"), "utf8");
    check("the limit is checked before anything is sent",
      /withinReviewerLimit\(prefs, target\)/.test(events)
        && events.indexOf("withinReviewerLimit") < events.indexOf("sendToPerson"));
    // Not a failure, and not recorded as one: somebody would otherwise see a
    // delivery error for a message they asked not to receive.
    // Anchored on the call site, not the import: the first occurrence of the
    // name in the file is the import line, and a window measured from there
    // lands nowhere near the code being asserted about.
    const callSite = events.indexOf("!withinReviewerLimit(prefs, target)");
    check("  and is skipped quietly rather than recorded as an error",
      callSite > 0 && /continue;/.test(events.slice(callSite, callSite + 120)),
      events.slice(callSite, callSite + 120));
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
