/**
 * What a Renovate pull request actually patches.
 *
 * The list said "Update all non-major dependencies" and left it there, so
 * deciding whether to merge meant opening GitHub anyway, which is the thing
 * this screen exists to save.
 *
 * The package list lives in the pull request body, as a markdown table Renovate
 * writes. That is prose, and parsing prose is the part to be careful about: the
 * table's columns have changed between Renovate versions and differ by preset,
 * so anything that assumes a column count or an order breaks quietly and shows
 * somebody a confident, wrong list of what they are about to merge.
 *
 * So the parse keys on the two things every version of that table has had: a
 * linked package name, and a version transition between backticks. A row
 * without both is skipped rather than guessed at, and a body that yields
 * nothing returns null rather than an empty list, because "this updates
 * nothing" and "we could not read what this updates" are opposite claims.
 */
import { parseRenovateChanges } from "./src/services/renovateChanges";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

console.log("the package table, as Renovate writes it today");
{
  const body = [
    "This PR contains the following updates:",
    "",
    "| Package | Change | Age | Confidence |",
    "|---|---|---|---|",
    "| [lodash](https://github.com/lodash/lodash) | [`4.17.20` -> `4.17.21`](https://diff) | ok | high |",
    "| [axios](https://github.com/axios/axios) | [`1.5.0` -> `1.6.0`](https://diff) | ok | high |",
    "",
    "---",
  ].join("\n");

  const out = parseRenovateChanges(body);
  check("both packages are read", out?.length === 2, out);
  check("  with their names", out?.[0].name === "lodash" && out?.[1].name === "axios", out);
  check("  and the versions either side", out?.[0].from === "4.17.20" && out?.[0].to === "4.17.21", out?.[0]);
}

console.log("\nand as older presets wrote it, with different columns");
{
  // Four columns in a different order. Anything keyed on position rather than
  // on shape reads the update type as a version here.
  const body = "| [react](https://r) | dependencies | minor | [`18.2.0` -> `18.3.1`](https://d) |";
  const out = parseRenovateChanges(body);
  check("the column order does not matter", out?.length === 1 && out?.[0].name === "react", out);
  check("  and the transition is still found", out?.[0].to === "18.3.1", out?.[0]);
}

console.log("\nthe arrow Renovate actually uses, in both spellings");
{
  check("an ascii arrow",
    parseRenovateChanges("| [a](u) | [`1.0.0` -> `1.1.0`](d) |")?.[0].to === "1.1.0");
  // Some presets render a unicode arrow.
  check("  and a unicode one",
    parseRenovateChanges("| [a](u) | [`1.0.0` → `1.1.0`](d) |")?.[0].to === "1.1.0");
}

console.log("\nrows that are not updates are not read as updates");
{
  const body = [
    "| Package | Change |",
    "|---|---|",
    "| [lodash](https://l) | [`4.17.20` -> `4.17.21`](https://d) |",
  ].join("\n");
  const out = parseRenovateChanges(body);

  // The header and the separator are table rows too, and both would become
  // packages named "Package" and "---" if every row were taken.
  check("the header row is not a package", out?.length === 1, out);
  check("  and neither is the separator", !out?.some(c => /^-+$/.test(c.name)), out);
}

console.log("\nnothing readable is null, never an empty list");
{
  // These are opposite claims: one says the pull request changes nothing, the
  // other says nobody could tell. Only the second is true here.
  check("a body with no table at all", parseRenovateChanges("Just some prose.") === null);
  check("  an empty body", parseRenovateChanges("") === null);
  check("  a missing body", parseRenovateChanges(undefined) === null);

  // A table whose rows carry no version transition is not a package list.
  check("  and a table that is not a package table",
    parseRenovateChanges(["| Note | Detail |", "|---|---|", "| [see](u) | below |"].join("\n")) === null);
}

console.log("\nthe same package twice is one entry");
{
  // Renovate lists a package once per manifest it appears in, and three rows
  // of "lodash 4.17.20 -> 4.17.21" is one thing happening, not three.
  const body = [
    "| [lodash](https://l) | [`4.17.20` -> `4.17.21`](https://d) |",
    "| [lodash](https://l) | [`4.17.20` -> `4.17.21`](https://d) |",
  ].join("\n");
  check("duplicates collapse", parseRenovateChanges(body)?.length === 1);

  // But the same package moving to two different versions is two facts.
  const twoWays = [
    "| [lodash](https://l) | [`4.17.20` -> `4.17.21`](https://d) |",
    "| [lodash](https://l) | [`3.0.0` -> `3.0.1`](https://d) |",
  ].join("\n");
  check("  while two different transitions are kept apart",
    parseRenovateChanges(twoWays)?.length === 2);
}

console.log("\na very long list is capped, and says it was");
{
  const rows = Array.from({ length: 80 },
    (_, i) => `| [pkg${i}](https://p) | [\`1.0.${i}\` -> \`1.1.${i}\`](https://d) |`).join("\n");
  const out = parseRenovateChanges(rows);
  // A grouped Renovate pull request can carry a hundred rows, and a card that
  // renders all of them is a card nobody can scroll past.
  check("no more than fifty are returned", (out?.length ?? 0) <= 50, out?.length);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
