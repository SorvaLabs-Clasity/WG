/**
 * The first screen after launching the app.
 *
 * "Every time I open the my work tab, I still have to wait for everything to
 * load the first time since opening the app." Said after the caching was built,
 * and the caching was not the problem.
 *
 * `awsHealthMiddleware` sits in front of every `/api` route and awaits a
 * DynamoDB scan before calling `next()`. On a cold process that scan resolves
 * the entire AWS credential chain underneath it: an SSO round trip and two TLS
 * handshakes, or an IMDS timeout when the session has expired. Seconds, before
 * any handler begins, which is why a route could truthfully log that it served
 * from storage in 280ms while the tab took twenty.
 *
 * Startup priming was added to move that cost off the first request. It did not
 * fix it, and this is why: `lastCheckTime` is set only when a scan *finishes*,
 * so it cannot stop a burst that all arrives before the first one returns, and
 * a freshly opened tab is exactly that burst. Priming started one check, the
 * page opened six requests, all six found the cache still empty, and all six
 * started their own.
 *
 * So the two have to go together. Priming decides *when* the cost is paid;
 * sharing the in-flight promise decides *how many times*. This pins both.
 *
 * Run:  npx tsx repro-coldstart.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import path from "node:path";
import { __setDocClientForTests } from "./src/utils/dynamo";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

(async () => {
  process.env.ACTIVITY_TABLE = "activity";

  console.log("a burst on a cold process pays for the credential chain once");
  {
    /**
     * The scan is deliberately slow here, standing in for the credential
     * resolution that makes the real one slow. What matters is how many start,
     * not how long each takes.
     */
    let scans = 0;
    const restore = __setDocClientForTests({
      send: async () => {
        scans++;
        await new Promise(r => setTimeout(r, 40));
        return {};
      },
    });

    // Imported after the stub is installed, so the module picks it up.
    const { isAwsHealthy } = await import("./src/middleware/awsHealthMiddleware");

    // Startup priming, then the page opening six requests at once, all before
    // the first scan has returned.
    const results = await Promise.all([
      isAwsHealthy(), isAwsHealthy(), isAwsHealthy(),
      isAwsHealthy(), isAwsHealthy(), isAwsHealthy(), isAwsHealthy(),
    ]);

    check("seven callers cause one scan, not seven", scans === 1, scans);
    check("  and every one of them gets the answer", results.every(r => r === true), results);

    // The window still has to work afterwards, or the health check would never
    // notice a session expiring.
    const before = scans;
    await isAwsHealthy();
    check("  while a later call inside the window does not scan again",
      scans === before, scans);

    restore();
  }

  console.log("\nthe cost is paid at startup rather than inside the first request");
  {
    const server = read("src/server.ts");

    check("the server warms it at boot",
      /const \{ isAwsHealthy \} = await import\("\.\/middleware\/awsHealthMiddleware"\)/.test(server)
        && /await isAwsHealthy\(\)/.test(server));
    check("  and warms the stored sweep the first screen reads",
      /await readDependencySnapshot\(\)/.test(server));

    /**
     * Priming alone was not enough, and the reason is worth keeping written
     * down: it does not block `listen`, so a page opened immediately still
     * races it. The sharing above is what makes that race harmless rather than
     * seven times as expensive.
     */
    const health = read("src/middleware/awsHealthMiddleware.ts");
    check("  and the check itself shares whatever is already running",
      /let inFlight: Promise<boolean> \| null = null;/.test(health)
        && /if \(inFlight\) return inFlight;/.test(health),
      "priming starts one check; the first burst started six more");
    check("  clearing it however the check ends",
      /\.finally\(\(\) => \{ inFlight = null; \}\)/.test(health),
      "a failure held here would be handed to every later caller forever");
  }

  console.log("\nthe expensive reads are shared rather than repeated");
  {
    // The same shape, in the two places a screen opens two requests at once
    // that read the same stored row.
    const snapshot = read("src/services/dependencySnapshot.ts");
    check("the stored Dependabot sweep is read once per burst",
      /let inFlight: Promise<StoredSweep \| null> \| null = null;/.test(snapshot)
        && /if \(inFlight\) return inFlight;/.test(snapshot));

    const membership = read("src/services/orgMembership.ts");
    check("  and so is the organization membership check",
      /inFlight/.test(membership));
  }

  console.log("\nasking for a handful of rows does not read the whole table");
  {
    /**
     * The other half of the same tab's cost, and the one that never showed up
     * in a route timer. `GET /api/me/alarms` wants the few rows one person
     * owns; the table it scans also holds the stored answers the rest of the
     * app keeps in it, hundreds of kilobytes each.
     */
    const alarms = read("src/services/alarmService.ts");
    check("the scan names the kind it wants",
      /async function allRecords\(kinds\?: readonly string\[\]\)/.test(alarms)
        && /filter: `#k IN \(/.test(alarms));
    check("  and no caller is left reading everything",
      (alarms.match(/allRecords\(\)/g) ?? []).length === 0);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
