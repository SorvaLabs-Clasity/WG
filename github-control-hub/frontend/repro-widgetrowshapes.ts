import fs from "node:fs";
import { widgetColumns } from "./src/lib/widgetColumns";
import { filterableColumns, applyWidgetFilters, valueFor } from "./src/lib/widgetFilters";

/**
 * Regression test: every column a check's table shows is backed by a field its
 * rows actually carry.
 *
 * The failure this catches is silent in the worst way. A column whose field the
 * rows never set renders as an empty cell, which reads as "no owner" rather
 * than "this check does not report one" — and a *filter* on that column matches
 * nothing at all, which reads as "none of your repositories are affected".
 * Both are confident answers to a question that was never asked.
 *
 * Row shapes are read out of graphService rather than written down here, so a
 * check that stops reporting a field fails this instead of quietly emptying a
 * column.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const SRC = "../backend/src/services/graphService.ts";
const src = fs.readFileSync(SRC, "utf8");

/**
 * The fields each `case "<id>":` block pushes onto its rows.
 *
 * A brace-matched slice per case, then every `key:` at the top level of a
 * `results.push({ … })`. Crude on purpose: it needs to see what the code
 * writes, not to understand it.
 */
function rowFieldsByQuery(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const caseRe = /^    case "([a-z-]+)":/gm;
  const starts: Array<{ id: string; at: number }> = [];
  for (const m of src.matchAll(caseRe)) starts.push({ id: m[1], at: m.index! });

  starts.forEach((c, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
    const body = src.slice(c.at, end);
    const fields = out.get(c.id) ?? new Set<string>();

    for (const push of body.matchAll(/results\.push\(\{/g)) {
      // Walk to the matching brace so a nested object does not end the block.
      let depth = 0, i2 = push.index! + push[0].length - 1;
      for (; i2 < body.length; i2++) {
        if (body[i2] === "{") depth++;
        else if (body[i2] === "}") { depth--; if (depth === 0) break; }
      }
      const obj = body.slice(push.index! + push[0].length, i2);
      // Top-level keys only: depth tracking again, so `metadata: { role: … }`
      // does not contribute `role`.
      let d = 0;
      for (let j = 0; j < obj.length; j++) {
        const ch = obj[j];
        if (ch === "{" || ch === "[" || ch === "(") d++;
        else if (ch === "}" || ch === "]" || ch === ")") d--;
        else if (d === 0) {
          const m = /^(\w+)\s*:/.exec(obj.slice(j));
          if (m && (j === 0 || /[\s,]/.test(obj[j - 1]))) fields.add(m[1]);
        }
      }
      // `...spread` and shorthand `repo,` both appear; catch the shorthand.
      for (const m of obj.matchAll(/(?:^|[\s,])(\w+)\s*(?:,|$)/g)) {
        if (!/^(true|false|null|undefined)$/.test(m[1])) fields.add(m[1]);
      }
    }
    out.set(c.id, fields);
  });
  return out;
}

/** One plausible row for a query, from the fields its code writes. */
function sampleRow(fields: Set<string>): any {
  const row: any = {};
  for (const f of fields) {
    if (f === "repo") row.repo = "payments-api";
    else if (f === "user") row.user = "alice";
    else if (f === "team") row.team = "platform";
    else if (f === "status") row.status = "fail";
    else if (f === "visibility") row.visibility = "public";
    else if (f === "bypasses") row.bypasses = 3;
    else if (f === "owner") row.owner = "alice";
    else if (f === "ownerKind") row.ownerKind = "committer";
    else row[f] = `${f} value`;
  }
  return row;
}

(async () => {
  const byQuery = rowFieldsByQuery();
  check(`row shapes were read for ${byQuery.size} checks`, byQuery.size >= 14, byQuery.size);

  console.log("\nevery column a check shows is backed by a field its rows carry");
  {
    const broken: string[] = [];
    for (const [id, fields] of byQuery) {
      if (fields.size === 0) continue;           // a case that returns a count
      const row = sampleRow(fields);
      const cols = widgetColumns({
        type: "query",
        hasStatus: !!row.status,
        hasOwner: "owner" in row,
        hasVisibility: "visibility" in row,
        hasBypasses: typeof row.bypasses === "number",
      });
      for (const c of cols) {
        if (c.id === "index" || c.id === "details") continue;  // not row fields
        if (valueFor(row, c.id) === undefined) broken.push(`${id}.${c.id}`);
      }
    }
    check("no check shows a column its rows never fill", broken.length === 0, broken);
  }

  console.log("\nthe subject column reads whichever field the check uses");
  {
    // Three different fields under one Entity column. A filter that only knew
    // about `repo` would match nothing on every user- and team-shaped check.
    const shapes: Array<[string, any, string]> = [
      ["a repository row", { repo: "payments-api" }, "payments-api"],
      ["a user row", { user: "alice" }, "alice"],
      ["a team row", { team: "platform" }, "platform"],
    ];
    for (const [label, row, want] of shapes) {
      check(`  ${label} answers with its subject`, valueFor(row, "entity") === want);
    }

    const userShaped = [...byQuery].filter(([, f]) => f.has("user")).map(([id]) => id);
    const teamShaped = [...byQuery].filter(([, f]) => f.has("team")).map(([id]) => id);
    check(`  ${userShaped.length} user-shaped and ${teamShaped.length} team-shaped checks exist`,
      userShaped.length > 0 && teamShaped.length > 0, { userShaped, teamShaped });

    for (const id of [...userShaped, ...teamShaped]) {
      const row = sampleRow(byQuery.get(id)!);
      const subject = valueFor(row, "entity");
      check(`    ${id} is filterable by its subject`,
        applyWidgetFilters([row], [{ column: "entity", values: [String(subject)] }]).length === 1,
        subject);
    }
  }

  console.log("\nevery filterable column can actually match a value from the data");
  {
    // The bug shape: a control that offers values which then match nothing.
    const dead: string[] = [];
    for (const [id, fields] of byQuery) {
      if (fields.size === 0) continue;
      const rows = [sampleRow(fields)];
      const cols = widgetColumns({
        type: "query",
        hasStatus: !!rows[0].status,
        hasOwner: "owner" in rows[0],
        hasVisibility: "visibility" in rows[0],
        hasBypasses: typeof rows[0].bypasses === "number",
      });
      for (const c of filterableColumns(cols, rows)) {
        const v = valueFor(rows[0], c.id);
        if (v === undefined || v === null) continue;
        const f = c.kind === "number"
          ? [{ column: c.id, min: Number(v), max: Number(v) }]
          : [{ column: c.id, values: [String(v)] }];
        if (applyWidgetFilters(rows, f).length !== 1) dead.push(`${id}.${c.id}`);
      }
    }
    check("a filter set from a row's own value keeps that row", dead.length === 0, dead);
  }

  console.log("\nthe checks that report an owner, and the ones that do not");
  {
    // Worth knowing out loud: filtering by person only works where the check
    // reports one, and on the others the column is correctly absent rather
    // than present-and-empty.
    const withOwner = [...byQuery].filter(([, f]) => f.has("owner")).map(([id]) => id).sort();
    const without = [...byQuery]
      .filter(([, f]) => f.size > 0 && !f.has("owner") && !f.has("user"))
      .map(([id]) => id).sort();
    console.log(`         owner column: ${withOwner.join(", ") || "none"}`);
    console.log(`         no owner:     ${without.join(", ") || "none"}`);
    check("at least one check reports an owner", withOwner.length > 0, withOwner);
    for (const id of without) {
      const cols = widgetColumns({ type: "query", hasStatus: false, hasOwner: false });
      check(`  ${id} does not show an owner column it cannot fill`,
        !cols.some(c => c.id === "owner"));
    }
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
