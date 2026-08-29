/**
 * Two dashboards out of one table.
 *
 * The Overview is one board seen by everybody, which is why changing it needs
 * an administrator. A personal board is not that, so the same gate would be
 * asking permission to arrange your own screen — and the same gate reversed
 * would let an administrator rearrange somebody else's.
 *
 * Three things therefore have to hold, and each fails in a different direction:
 *
 *   the shared board must not change because personal ones now exist
 *   a personal widget must not appear on anybody else's board
 *   the owner must come from the session, never from the request
 *
 * The last one is the sharp edge: an owner read from the body would be a way to
 * put a card on a colleague's dashboard.
 *
 * Run:  npx tsx repro-personalwidgets.ts   from github-control-hub/backend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const route = fs.readFileSync("./src/routes/widgets.ts", "utf8");
const service = fs.readFileSync("./src/services/widgetService.ts", "utf8");

/** The body of one route handler, so an assertion cannot match a neighbour. */
function handler(marker: string): string {
  const i = route.indexOf(marker);
  return i < 0 ? "" : route.slice(i, route.indexOf("\n});", i));
}

(async () => {
  // ── the shared board is unchanged ───────────────────────────────────
  {
    check("a widget with no owner is a shared one",
      /owner\?: string;/.test(service),
      "optional, so every widget created before this is shared and needs no migration");

    const list = handler('router.get("/", async');
    check("asking without a scope returns only the shared board",
      /: !w\.owner/.test(list),
      "otherwise everybody's personal cards appear on the Overview tab");
    check("  and asking for personal returns only your own",
      /w\.owner\?\.toLowerCase\(\) === login/.test(list));
    check("  compared case-insensitively, as GitHub logins are",
      /req\.user!\.login\.toLowerCase\(\)/.test(list),
      "an exact match gives somebody an empty board that reads as having none");
    check("  and the filtering happens on the server",
      !/scope === "personal"[\s\S]{0,80}res\.json\(all\)/.test(list),
      "shipping the table to be filtered in a browser puts every board in every page");
  }

  // ── whose board a card lands on ─────────────────────────────────────
  {
    const create = handler('router.post("/", async');
    check("the owner comes from the session",
      /const owner = personal \? req\.user!\.login : undefined;/.test(create),
      "an owner read from the body is a way to post a card to a colleague's dashboard");
    check("  never from the request body",
      !/owner\s*[:=]\s*(req\.body|body)\.owner/.test(create));
    check("  a shared widget still needs an administrator",
      /if \(!owner && await refusedWidgetChange/.test(create),
      "the gate exists for the board everybody sees, and that has not changed");
    check("  and a personal one does not",
      /!owner &&/.test(create),
      "asking permission to arrange your own screen is the wrong shape");
  }

  // ── changing one ────────────────────────────────────────────────────
  {
    check("edits are gated on what is stored, not on what was sent",
      /const existing = \(await listWidgets\(\)\)\.find\(w => w\.id === id\)/.test(route),
      "reading the owner from the request would let anybody claim any widget");
    check("  a shared widget still takes the admin gate",
      /if \(!existing\.owner\) return refusedWidgetChange/.test(route));
    check("  your own is yours to change",
      /existing\.owner\.toLowerCase\(\) === login\.toLowerCase\(\)/.test(route));
    // An administrator has no business rearranging a person's own dashboard.
    check("  and somebody else's is refused outright, admin or not",
      /That widget is on somebody else's dashboard/.test(route),
      "falling back to the admin gate would let an admin edit a personal board");
    check("deleting takes the same route as editing",
      (route.match(/refusedWidgetEdit\(/g) ?? []).length >= 3,
      "a delete guarded differently from an edit is the hole");
    check("  and a missing widget is a 404 rather than a permission answer",
      /if \(!existing\) \{ res\.status\(404\)/.test(route));
  }

  // ── the front end reuses rather than reimplements ───────────────────
  {
    const board = fs.readFileSync("../frontend/src/components/PersonalBoard.tsx", "utf8");
    check("the personal board renders the shared board's own card",
      /import \{ CheckCard, WidgetFormModal \} from "\.\.\/pages\/AnalyticsPage"/.test(board),
      "a second card would drift from the verdicts and freshness stamps in the first");
    check("  and marks what it creates as personal",
      /personal: true/.test(board));

    const hooks = fs.readFileSync("../frontend/src/hooks/useWidgets.ts", "utf8");
    check("the two boards do not share a cache entry",
      /queryKey: \["widgets", scope \?\? "org"\]/.test(hooks),
      "one key means opening one board briefly shows the other's cards");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
