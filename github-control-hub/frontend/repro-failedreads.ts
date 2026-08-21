/**
 * A failure must never render as "there is nothing here".
 *
 * The two look identical, and the empty one is *reassuring*: "Nothing
 * outstanding", "No alarms yet", "Nobody matches". Somebody whose token had
 * expired, or whose laptop slept long enough for the credentials behind a tab
 * to go stale, was told in a calm voice that there was nothing to see. On a
 * security screen that is the worst available answer — it under-reports, and it
 * looks deliberate.
 *
 * The same shape on the write side is the one people report as "the button does
 * nothing": a result carrying `reachable: false` and the reason, discarded by
 * the caller. That is asserted here too, because it kept coming back — four
 * separate handlers on the sign-in screen had it.
 *
 * Run:  npx tsx repro-failedreads.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const read = (p: string) => fs.readFileSync(p, "utf8");

(async () => {
  // ── the reads ───────────────────────────────────────────────────────
  {
    const design = read("src/design/index.tsx");
    check("there is one shared way to say a read failed",
      /export function LoadFailed/.test(design));
    check("  and it names what could not be read",
      /Could not load \$\{what\}/.test(design),
      '"Something went wrong" tells a person nothing they can act on');
    check("  and says an empty result is not what this is",
      /not a sign that there is nothing there/.test(design));

    // The screens where a calm "nothing here" is actively misleading.
    const pages: [string, string][] = [
      ["SecurityPage.tsx", "security alerts"],
      ["AlarmsPage.tsx", "your alarms"],
      ["AccessPage.tsx", "the access map"],
    ];
    for (const [file, what] of pages) {
      const s = read(`src/pages/${file}`);
      check(`${file} reports a failed read`,
        s.includes("<LoadFailed") && s.includes(what), what);
    }

    // Security derives its whole headline from counts, so the check has to come
    // before them: an unread list counts as zero, which renders as the all-clear.
    const sec = read("src/pages/SecurityPage.tsx");
    check("  and Security does so before it counts anything",
      sec.indexOf("alertsFailed) {") < sec.indexOf("const clean ="),
      "counting an unread list gives zero, and zero renders as the all-clear");

    // Each list on Access has its own query; one failing must not blank the others.
    const access = read("src/pages/AccessPage.tsx");
    for (const [mode, flag] of [["people", "isError"], ["teams", "teamsFailed"], ["repos", "reposFailed"]]) {
      check(`  Access reports the ${mode} list separately`,
        new RegExp(`mode === "${mode}" && [^\\n]*${flag}`).test(access), flag);
    }
  }

  // ── the writes ──────────────────────────────────────────────────────
  {
    const page = read("src/pages/LoginPage.tsx");
    // Every one of these was silent at some point, and each looked like a dead
    // button rather than a refusal.
    for (const handler of [
      "handleReconnectAws", "handleUseProfile", "handleAccessKeys", "handlePasteBlockConnect",
    ]) {
      const from = page.slice(page.indexOf(`const ${handler}`));
      const body = from.slice(0, from.indexOf("\n  };"));
      check(`${handler} reports a refusal rather than discarding it`,
        /!result\.reachable/.test(body) || /setNewError/.test(body),
        "an ignored result is a button that appears to do nothing");
    }

    const switcher = read("src/components/AwsAccountSwitcher.tsx");
    check("  and the account switcher still does the same",
      /!result\.reachable/.test(switcher));

    // Mutations are covered centrally, which is why no hook needs an onError.
    const app = read("src/App.tsx");
    check("mutation failures are announced from one place",
      /<MutationErrors \/>/.test(app),
      "without this every mutation would need its own onError, and most had none");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
