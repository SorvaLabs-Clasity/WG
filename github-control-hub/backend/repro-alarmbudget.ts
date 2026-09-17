/**
 * The alarm pass stops on the clock, not on Lambda killing it.
 *
 * The handler took no arguments, so it never saw Lambda's context and had no
 * way to know how long it had left. It ran until it was killed. A timeout is an
 * error, an errored schedule is retried, and with a five-minute ceiling on a
 * five-minute schedule the retries overlap the next pass — so the function runs
 * essentially without stopping. That was found from a bill: $21 of compute in a
 * month is about 290 seconds an invocation against a 300-second ceiling.
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const src = fs.readFileSync("./src/alarms/handler.ts", "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

console.log("the pass knows how long it has");
{
  check("the handler accepts Lambda's context",
    /export async function handler\([^)]*context\?:/.test(code),
    "a handler taking no arguments cannot ask how long it has left");
  check("  and reads the remaining time from it",
    /getRemainingTimeInMillis/.test(code));
  check("  keeping a reserve, so it can finish and return rather than be killed",
    /RESERVE_MS/.test(code) && /budget - RESERVE_MS/.test(code));
  check("  and still has a budget with no context, so a local run behaves the same way",
    /LOCAL_BUDGET_MS/.test(code),
    "a second code path for 'no deadline' is a second thing to get wrong");
}

console.log("\nevery warm phase yields to the clock");
{
  /**
   * Everything after the alarm evaluation is cache warming. A warm that does
   * not happen costs somebody one slow page load; a timeout costs the whole
   * pass, including alarms that had not been reached.
   */
  const guards = (code.match(/outOfTime\(\)/g) ?? []).length;
  check("more than one phase checks the clock", guards >= 3, guards);

  check("  the My work warm stops and says how many are left",
    /stopped on the clock with/.test(src));
  check("  the widget snapshots stop rather than eat the invocation",
    /if \(outOfTime\(\)\) \{ widgetsLeft = /.test(code));
  check("  and the dependency sweep is not started without real time in hand",
    /timeLeft\(\) > 90_000/.test(code),
    "the most expensive thing the pass can do, started with two minutes left, cannot finish");
}

console.log("\nand a pass that came close says so");
{
  check("the duration is logged every pass",
    /pass took \$\{Math\.round\(tookMs/.test(src),
    "without it, the only way to learn a pass runs to its ceiling is the bill");
  check("  and a pass that nearly ran out warns, naming the overlap",
    /overlaps the next one/.test(src));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
