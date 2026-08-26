/**
 * Access is not authorship, and the Repos tab said it was.
 *
 * The repository panel listed everyone GitHub returns as a *collaborator* under
 * a heading reading "Collaborators", with a role pill and nothing else. That is
 * a question about who can reach the repository. An organization owner holds
 * admin on every repository in the organization without ever having opened one,
 * and appeared there identically to somebody deliberately given write access to
 * this repository in particular — which is why the list was full of people who
 * had never committed anything.
 *
 * The `source` that distinguishes them (`direct`, `team`, `org_owner`) was
 * stored on every collaborator edge and passed through the API untouched. Only
 * the rendering dropped it. The Access tab had always shown it; this panel is
 * the one place that did not.
 *
 * Run:  npx tsx repro-accesswording.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const read = (p: string) => fs.readFileSync(p, "utf8");
const code = (s: string) => s.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

(async () => {
  const graph = read("./src/pages/KnowledgeGraphPage.tsx");
  const graphCode = code(graph);

  // ── the heading says what the list is ───────────────────────────────
  {
    check("the repository panel does not call access 'Collaborators'",
      !/label="Collaborators"/.test(graphCode),
      "the word is read as 'people who worked on this', which is the other list");
    check("  it says whose question it answers",
      /label="People with access"/.test(graphCode));
    check("  and says outright that it is not authorship",
      /[Nn]ot who has worked on it/.test(graph),
      "a reader who does not already know the difference has no way to learn it here");
    check("  pointing at the list that does answer commits",
      /Top contributors/.test(graph));
  }

  // ── how each person got access is shown ─────────────────────────────
  {
    check("the edge's source is carried out of the graph data",
      /source: e\.metadata\?\.source/.test(graphCode),
      "it was stored and passed through the API; only the render dropped it");
    for (const [value, label] of [
      ["org_owner", "org owner"], ["team", "via team"], ["direct", "direct"],
    ]) {
      check(`  ${value} is labelled "${label}"`,
        new RegExp(`c\\.source === "${value}" && <Pill[^>]*>${label}`).test(graphCode),
        value);
    }
    check("  blanket organization access sorts last, whatever its role",
      /org_owner: 2/.test(graphCode),
      "an owner outranks everyone on paper and says the least about this repository");
  }

  // ── the headline count is not every owner in the organization ───────
  {
    check("the count tile excludes organization-wide access",
      /c\.source !== "org_owner"/.test(graphCode),
      "counting owners made every repository report the same number");
    check("  and the tile is named for what it counts",
      /label: "With access"/.test(graphCode) && !/label: "People"/.test(graphCode),
      '"People" reads as the people involved with the repository');
  }

  // ── the Access tab, which already had this right ────────────────────
  {
    const access = read("./src/pages/AccessPage.tsx");
    check("the Access tab still spells out organization-owner access",
      /via === "org_owner"/.test(access) && /organization owner/.test(access),
      "this is the behaviour the repository panel was missing");
  }

  // ── and the Who knows tab is a different question entirely ──────────
  //
  // Checked because the two were reported together. It scores commits, reviews
  // and issue comments; if it ever started reading access edges it would have
  // the same defect, silently.
  {
    const svc = read("../backend/src/services/expertiseService.ts");
    check("'who knows' is answered from activity, never from access",
      !/has_collaborator|collaborates_on|graph-edges|GRAPH_EDGES/.test(svc),
      "access would let somebody who never opened the file rank as an expert");
    check("  it counts commits and reviews",
      /commits: number/.test(svc) && /reviews: number/.test(svc));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
