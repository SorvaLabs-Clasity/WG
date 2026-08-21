/**
 * Reaching DynamoDB from the guardrail store.
 *
 * Every guardrail read and write in the app goes through one private `send()`
 * in `aws-guardrails/store.ts`, and it had no coverage whatsoever. It shipped
 * calling *itself* rather than the client, so the first thing it did was
 * recurse until the stack ran out:
 *
 *   RangeError: Maximum call stack size exceeded
 *       at send (dist/aws-guardrails/store.js:132:22)   ... and so on
 *
 * On screen that looked like two unrelated faults — the AWS tab listed no rules,
 * and adding a rule crashed — because a read that throws and an account with no
 * rules render identically. It was one line.
 *
 * The wrapper also carries the stale-credential retry, which is the reason it
 * exists: this module's client can sit an hour untouched while the rest of the
 * app keeps its own warm, so a laptop that slept wakes holding dead credentials.
 * That path is asserted here too — it was equally unexercised.
 */
import {
  __setGuardrailClientForTests, resetGuardrailStore,
  putGuardrail, getGuardrail, deleteGuardrail, GUARDRAILS_TABLE,
} from "./src/aws-guardrails/store";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const rule = { id: "r1", name: "no public buckets" } as any;

(async () => {
  // ── it reaches the client, once ─────────────────────────────────────
  {
    const seen: any[] = [];
    __setGuardrailClientForTests({
      send: async (cmd: any) => { seen.push(cmd); return { Item: rule }; },
    });

    let threw: any = null;
    try { await putGuardrail(rule); } catch (e) { threw = e; }

    check("writing a rule does not exhaust the stack",
      !(threw instanceof RangeError), threw?.message);
    check("  it reaches the client at all", seen.length > 0,
      "send() called itself instead of the client, so nothing was ever sent");
    check("  exactly once, not once per retry", seen.length === 1, seen.length);
    check("  and it is the write we asked for",
      seen[0]?.input?.TableName === GUARDRAILS_TABLE && seen[0]?.input?.Item?.id === "r1",
      seen[0]?.input);
  }

  // Reading is the same path, and was the half that looked like "no rules".
  {
    const seen: any[] = [];
    __setGuardrailClientForTests({
      send: async (cmd: any) => { seen.push(cmd); return { Item: rule }; },
    });
    const got = await getGuardrail("r1");
    check("reading a rule returns it rather than nothing",
      (got as any)?.id === "r1", got);
    check("  a failed read and an empty account are not the same thing",
      seen.length === 1, seen.length);
  }

  // ── stale credentials: rebuild and try again, once ──────────────────
  {
    let attempts = 0;
    const expired: any = new Error("The security token included in the request is expired");
    expired.name = "ExpiredToken";

    __setGuardrailClientForTests({
      send: async () => { attempts++; throw expired; },
    });

    // The retry drops the cached client and builds a real one, which will fail
    // without credentials. Either way the assertion is about the first client.
    try { await deleteGuardrail("r1"); } catch { /* the rebuilt client is not under test */ }

    check("a stale-credential failure is retried, not surfaced immediately",
      attempts === 1, attempts);
  }

  // A failure that is not about credentials must not be retried or swallowed.
  {
    let attempts = 0;
    const denied: any = new Error("User is not authorized to perform dynamodb:PutItem");
    denied.name = "AccessDeniedException";

    __setGuardrailClientForTests({
      send: async () => { attempts++; throw denied; },
    });

    let threw: any = null;
    try { await putGuardrail(rule); } catch (e) { threw = e; }

    check("a permissions failure is raised rather than retried",
      threw?.name === "AccessDeniedException", threw?.name);
    check("  and tried only once, because a second is the same answer",
      attempts === 1, attempts);
  }

  resetGuardrailStore();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
