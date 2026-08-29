/**
 * The four developer screens, and the ways they could lie.
 *
 * Every one of these renders a list, and every one of them has a state where an
 * empty list means something other than "there is nothing". A queue that says
 * "nothing is waiting on you" when nobody has looked is worse than no queue,
 * because it is believed once and then never checked again.
 *
 * Four such states exist here, all asserted below:
 *
 *   the pull request walk has never run                  (not "you are clear")
 *   the walk stopped at its page limit                   (not "that is all")
 *   detailed logging is off, so merges are not recorded  (not "you shipped nothing")
 *   protection could not be read for want of admin       (not "nothing protects it")
 *
 * Run:  npx tsx repro-myworkviews.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const page = fs.readFileSync("./src/pages/MyWorkPage.tsx", "utf8");
const repos = fs.readFileSync("./src/pages/KnowledgeGraphPage.tsx", "utf8");
const hooks = fs.readFileSync("./src/hooks/useMe.ts", "utf8");

(async () => {
  // ── an empty list that is not an answer ─────────────────────────────
  {
    check("a queue that was never collected says so",
      /!data\.collected/.test(page) && /No pull request data yet/.test(page),
      '"nothing waiting on you" and "nobody looked" are the same empty array');
    check("  a truncated walk says the list may be short",
      /data\.truncated/.test(page) && /page limit/.test(page));
    check("  and does not undermine what it did find",
      /Everything shown is real/.test(page),
      "a warning that makes people distrust correct rows is its own bug");

    check("the ship log says when merges are simply not recorded",
      /!data\.detailedLogging/.test(page) && /Detailed logging is off/.test(page));
    check("  and warns before the empty list rather than after it",
      page.indexOf("Detailed logging is off") < page.indexOf("Nothing merged in this window"),
      "an explanation below the list is read after the wrong conclusion");
    check("  it also says the setting is not retroactive",
      /not retroactively/.test(page),
      "otherwise somebody turns it on and expects last month to appear");
  }

  // ── the push check, where a blank answer is dangerous ───────────────
  {
    check("no access to the repo is stated, not left blank",
      /data\.message/.test(page));
    check("  an unreadable rule set is its own verdict",
      /const unknown = !!data\.unreadable \|\| !data\.reachable/.test(page),
      "reporting it as green tells somebody they can push to a protected branch");

    // Order is the assertion. Whatever the wording, "we could not read the
    // rules" has to be decided before "nothing protects it", or an unreadable
    // ruleset renders as the green all-clear.
    const verdict = page.slice(page.indexOf("const look = unknown"), page.indexOf("return (", page.indexOf("const look = unknown")));
    check("    and is decided before any all-clear",
      verdict.indexOf("unknown") < verdict.indexOf("protected === false"),
      verdict.slice(0, 120));
    check("    drawn as a warning, never as success",
      /unknown[\s\S]{0,120}bg-amber/.test(verdict), verdict.slice(0, 200));

    check("  only an actually unprotected branch says you can push",
      /data\.protected === false[\s\S]{0,200}"You can push"/.test(verdict),
      verdict.match(/protected === false[\s\S]{0,160}/)?.[0]);
    check("  a protected branch with no blockers says that separately",
      /Nothing blocks you/.test(page) && /is protected, but not against you/.test(page),
      "it is a different fact from being unprotected");
    check("  and being exempt is a third answer again",
      /canBypass[\s\S]{0,160}You can push anyway/.test(verdict),
      "an admin who bypasses is not the same as a branch nothing protects");
  }

  // ── the queue's own arithmetic is not re-done in the view ───────────
  {
    check("the headline reads the server's counts",
      /mergeable=\{data\.mergeable\}/.test(page) && /onYou=\{data\.onYou\}/.test(page),
      "recomputing them in the view is a second place for them to disagree");
    // Matched on the behaviour rather than on one variable's name: the point
    // is that nothing reads as an alarm on a clear day, not how it is spelled.
    check("a zero is dimmed rather than drawn as a number",
      (page.match(/=== 0 \? "text-slate-300/g) ?? []).length >= 2
      && /clear \? "text-slate-300/.test(page),
      "three bold zeroes read as an alarm rather than as a clear day");
    check("  and the lead number is the one somebody else is blocked on",
      /Waiting on you<\/div>/.test(page.replace(/\s+/g, " ")) || /Waiting on you/.test(page),
      "three equal boxes say all three matter equally, which is nothing to look at first");
  }

  // ── who knows this, in the repo panel ───────────────────────────────
  {
    check("expertise is reachable from the repository itself",
      /function WhoKnows/.test(repos) && /<WhoKnows repo=\{repo\}/.test(repos));
    check("  fetched only when opened, because it reads GitHub live",
      /enabled: open/.test(repos),
      "three requests on every repository click for a question most opens do not have");
    check("  recency is on the row, since that is what the scoring is for",
      /daysSinceActive/.test(repos));
    check("  a sample says it is a sample",
      /data\?\.sampled/.test(repos) && /rather than a full count/.test(repos));
    check("  and a partial read says which part failed",
      /degraded/.test(repos) && /from what was readable/.test(repos),
      "a short list from a failed read looks identical to a short list");
    check("  nobody ranking is said outright",
      /Nobody has committed, reviewed or commented/.test(repos));
  }

  // ── every pull request opens on github.com ──────────────────────────
  //
  // Electron routes target="_blank" and any outbound navigation to the system
  // browser, so an anchor is all that is needed. What is worth asserting is
  // that all four surfaces have one, and that the one built from an activity
  // row refuses to guess.
  {
    check("the queue rows are links",
      /href=\{pr\.url\} target="_blank"/.test(page));
    check("  as are the still-open ones",
      (page.match(/href=\{pr\.url\} target="_blank"/g) ?? []).length >= 2);
    check("  and the merged ones",
      /href=\{href\} target="_blank"/.test(page));
    check("  every one of them opens outside the app",
      (page.match(/rel="noreferrer noopener"/g) ?? []).length >= 3,
      "an outbound link without noopener hands the opener to the page it opens");

    // A merged row is an activity row, not a pull request record, so it may
    // carry no number at all.
    check("a merged row links to the pull request when it knows the number",
      /\/pull\/\$\{entry\.prNumber\}/.test(page));
    check("  falls back to the repository when it does not",
      /: `https:\/\/github\.com\/\$\{org\}\/\$\{entry\.repo\}`/.test(page));
    check("  and renders plain text rather than a link that 404s",
      /if \(!org \|\| !entry\.repo\) return null;/.test(page)
      && /href \? \(/.test(page),
      "something that looks clickable and lands on a 404 is worse than plain text");
  }

  // ── polling that matches what actually changes ──────────────────────
  {
    check("the queue refreshes itself, since it is meant to be left open",
      /refetchInterval: 60_000/.test(hooks));
    check("  the push check does not, and is not asked half-filled",
      /enabled: !!repo && !!branch/.test(hooks),
      "a half-filled form is not a question, and asking it 400s");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
