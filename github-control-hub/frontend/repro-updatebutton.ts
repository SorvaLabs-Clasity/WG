/**
 * "Check for updates", on the sign-in screen and in the account menu.
 *
 * The automatic check says nothing when there is nothing new, and nothing when
 * it could not ask — before AWS is connected, or on an account with no GitHub
 * App — so "am I on the latest?" had no answer. The button runs the *same*
 * check (one runner in the desktop main process, which the half-hourly
 * schedule also calls) and says what it found.
 *
 * Run:  npx tsx repro-updatebutton.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const main = fs.readFileSync("../desktop/src/main.ts", "utf8");
const preload = fs.readFileSync("../desktop/src/preload.ts", "utf8");
const button = fs.readFileSync("src/components/CheckForUpdates.tsx", "utf8");
const navbar = fs.readFileSync("src/components/Navbar.tsx", "utf8");
const login = fs.readFileSync("src/pages/LoginPage.tsx", "utf8");

console.log("one check, whoever asks");
{
  check("the desktop app answers the button's request",
    /ipcMain\.handle\("check-for-updates", \(\) => runUpdateCheck\(\)\)/.test(main));
  const schedule = main.slice(main.indexOf("function scheduleUpdateChecks"));
  check("  and the schedule runs the same check, not a copy of it",
    /await runUpdateCheck\(\)/.test(schedule.slice(0, 2500)) && !/autoUpdater\.checkForUpdates\(\)/.test(schedule));
  check("  and a press during a running check joins it",
    /if \(checkInFlight\) return checkInFlight;/.test(main));
  check("the bridge exposes it",
    /checkForUpdates: \(\): Promise<unknown> => ipcRenderer\.invoke\("check-for-updates"\)/.test(preload));
}

console.log("\nit says what it found");
{
  for (const outcome of ["up-to-date", "downloading", "unavailable", "failed"]) {
    check(`the button has words for "${outcome}"`, button.includes(`"${outcome}"`));
  }
  check("every reason it could not ask is explained where it is decided",
    ["dev", "backend", "aws", "token"].every(r => new RegExp(`reason: "${r}",\\s*message:`).test(main)));
}

console.log("\nwhere it is");
{
  check("on the sign-in screen", /<CheckForUpdates variant="link" \/>/.test(login));
  check("in the account menu", /<CheckForUpdates variant="menu" \/>/.test(navbar));
  check("in the narrow-screen menu", /<CheckForUpdates variant="sheet" \/>/.test(navbar));
  check("and not in a browser, where there is nothing to update",
    /const check = window\.electronAPI\?\.checkForUpdates;\s*\n\s*if \(!check\) return null;/.test(button));
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
