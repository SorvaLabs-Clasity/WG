/**
 * Search, sort and paging arithmetic for result tables.
 *
 * The first frontend suite in this repo — everything else under repro-*.ts is
 * backend. Run it the same way:  npx tsx repro-tablecontrols.ts  from
 * github-control-hub/frontend.
 *
 * It tests `src/lib/tableControls.ts` rather than the hook that wraps it,
 * because the part that breaks is arithmetic at boundaries and none of it needs
 * React. The specific failures worth naming:
 *
 *   - narrowing a search while on a late page leaves you on a page that no
 *     longer exists, and an empty table reads as "no results" rather than
 *     "wrong page"
 *   - a page of exactly perPage rows must not imply another page exists
 *   - sorting must not mutate the caller's array, which elsewhere is React
 *     state and would tear the render
 */
import { applyTableControls, compareValues, matchesSearch, type Column } from "./src/lib/tableControls";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

interface Row { repo: string; severity: string; count: number }
const rows: Row[] = [
  { repo: "auth-service", severity: "critical", count: 12 },
  { repo: "billing-api", severity: "low", count: 3 },
  { repo: "Checkout-Web", severity: "high", count: 7 },
  { repo: "sandbox-repo", severity: "low", count: 0 },
  { repo: "auth-proxy", severity: "high", count: 5 },
];
const columns: Column<Row>[] = [
  { key: "repo", label: "Repository", value: r => r.repo },
  { key: "count", label: "Alerts", value: r => r.count },
];
const base = {
  rows, searchText: (r: Row) => `${r.repo} ${r.severity}`, columns,
  search: "", sortKey: null as string | null, sortDir: "asc" as const, page: 1, perPage: 25,
};

// ── search ────────────────────────────────────────────────────────────
{
  const r = applyTableControls({ ...base, search: "auth" });
  check("search narrows to matching rows", r.matchCount === 2, r.matchCount);

  const ci = applyTableControls({ ...base, search: "CHECKOUT" });
  check("  and is case-insensitive in both directions", ci.matchCount === 1, ci.matchCount);

  const field = applyTableControls({ ...base, search: "high" });
  check("  matching any field the page nominates, not just the name", field.matchCount === 2, field.matchCount);

  const blank = applyTableControls({ ...base, search: "   " });
  check("  whitespace is not a search", blank.matchCount === rows.length, blank.matchCount);

  // A stray bracket is a character someone typed, not a pattern.
  const paren = applyTableControls({ ...base, search: "auth(" });
  check("  a regex metacharacter narrows rather than throws", paren.matchCount === 0, paren.matchCount);

  check("matchesSearch is substring, not prefix", matchesSearch("billing-api", "api"));
}

// ── sort ──────────────────────────────────────────────────────────────
{
  const asc = applyTableControls({ ...base, sortKey: "repo", sortDir: "asc" });
  check("sorts by a named column, case-insensitively",
    asc.visible.map(r => r.repo)[0] === "auth-proxy", asc.visible.map(r => r.repo));
  check("  Checkout-Web sorts among the c's, not before every lowercase name",
    asc.visible.map(r => r.repo)[2] === "billing-api" || asc.visible.map(r => r.repo)[3] === "Checkout-Web",
    asc.visible.map(r => r.repo));

  const desc = applyTableControls({ ...base, sortKey: "repo", sortDir: "desc" });
  check("  and reverses", desc.visible[0].repo === "sandbox-repo", desc.visible[0].repo);

  const num = applyTableControls({ ...base, sortKey: "count", sortDir: "desc" });
  check("numbers sort numerically, not as text",
    num.visible.map(r => r.count).join(",") === "12,7,5,3,0", num.visible.map(r => r.count));

  const before = rows.map(r => r.repo).join(",");
  applyTableControls({ ...base, sortKey: "repo", sortDir: "asc" });
  check("sorting does not mutate the caller's array", rows.map(r => r.repo).join(",") === before);

  const unknown = applyTableControls({ ...base, sortKey: "nope" });
  check("an unknown sort key leaves the order alone",
    unknown.visible.map(r => r.repo).join(",") === before, unknown.visible.map(r => r.repo));
}

// ── blanks sort last ──────────────────────────────────────────────────
{
  check("a blank sorts after a value ascending", compareValues("", "a", "asc") > 0);
  check("  and still after it descending", compareValues("", "a", "desc") > 0);
  check("two blanks tie", compareValues(null, undefined, "asc") === 0);
}

// ── paging ────────────────────────────────────────────────────────────
{
  const many = Array.from({ length: 57 }, (_, i) => ({ repo: `r${i}`, severity: "low", count: i }));
  const p1 = applyTableControls({ ...base, rows: many, perPage: 25, page: 1 });
  check("a full page holds perPage rows", p1.visible.length === 25, p1.visible.length);
  check("  and reports the right page count", p1.totalPages === 3, p1.totalPages);

  const p3 = applyTableControls({ ...base, rows: many, perPage: 25, page: 3 });
  check("  the last page holds the remainder", p3.visible.length === 7, p3.visible.length);

  const exact = Array.from({ length: 25 }, (_, i) => ({ repo: `r${i}`, severity: "low", count: i }));
  const e = applyTableControls({ ...base, rows: exact, perPage: 25, page: 1 });
  check("exactly perPage rows is one page, not two", e.totalPages === 1, e.totalPages);

  const empty = applyTableControls({ ...base, rows: [], perPage: 25, page: 1 });
  check("no rows is still one page, not zero", empty.totalPages === 1 && empty.visible.length === 0,
    { totalPages: empty.totalPages, visible: empty.visible.length });
}

// ── the stranded-page bug ─────────────────────────────────────────────
{
  const many = Array.from({ length: 57 }, (_, i) => ({ repo: `r${i}`, severity: "low", count: i }));
  // On page 3, then a search that leaves two matches. Page 3 no longer exists.
  const stranded = applyTableControls({ ...base, rows: many, perPage: 25, page: 3, search: "r1 " });
  check("narrowing while on a late page shows results, not a blank table",
    stranded.visible.length > 0, { safePage: stranded.safePage, visible: stranded.visible.length });
  check("  by clamping to the last real page", stranded.safePage === stranded.totalPages,
    { safePage: stranded.safePage, totalPages: stranded.totalPages });

  const negative = applyTableControls({ ...base, rows: many, perPage: 25, page: 0 });
  check("a page below the first clamps up", negative.safePage === 1, negative.safePage);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
