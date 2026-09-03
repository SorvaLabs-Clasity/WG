/**
 * "Only when the review is mine to do", asked by three screens instead of one.
 *
 * The review-request notification had this cap. The daily summary and the queue
 * did not, so the same person could be told "not yours, eight people are on it"
 * at the moment of the request and then handed that same pull request in the
 * morning summary and again in their queue.
 *
 * The counting rule is now in one module, and the interesting part is that the
 * two shapes it counts are different in a way that invites an off-by-one: a
 * webhook payload lists the *other* reviewers, the reader having been removed,
 * while a pull request row lists *everybody* still pending, the reader among
 * them. Adding one to both, or to neither, is wrong in opposite directions and
 * neither shows up as an error.
 */
import { withinLimit, totalFromEvent, totalFromPull, keepWithinLimit } from "./src/services/reviewerLimit";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

console.log("the two shapes are counted differently, and both give the same answer");
{
  // Three people are on this review: the reader, and two others.
  check("a payload adds the reader back, because it lists only the others",
    totalFromEvent({ reviewers: ["carol", "dave"] }) === 3);
  check("  a row does not, because the reader is already in it",
    totalFromPull({ pending: ["bob", "carol", "dave"] }) === 3);

  // The same three-person review, seen from both sides, must pass and fail the
  // same limits. Counting the reader twice is the mistake that would not show
  // up as an error anywhere.
  for (const limit of [1, 2, 3, 4]) {
    const viaEvent = withinLimit(limit, totalFromEvent({ reviewers: ["carol", "dave"] }));
    const viaRow = withinLimit(limit, totalFromPull({ pending: ["bob", "carol", "dave"] }));
    check(`  and agree at a limit of ${limit}`, viaEvent === viaRow, { viaEvent, viaRow });
  }
}

console.log("\na team counts as one, not as nobody");
{
  // Four teams asked is four groups who might pick it up. Counting them as
  // nobody would make that look like a review only the reader can do.
  check("teams are added to the payload count",
    totalFromEvent({ reviewers: [], reviewerTeams: ["platform", "security"] }) === 3);
  check("  and to the row count",
    totalFromPull({ pending: ["bob"], pendingTeams: ["platform"] }) === 2);
}

console.log("\nan unreadable list never withholds anything");
{
  // Silently dropping a review because a number could not be read leaves
  // somebody waiting on a review they were never told about.
  check("a payload with no reviewer list passes any limit",
    withinLimit(1, totalFromEvent({})) === true);
  check("  as does a row with none", withinLimit(1, totalFromPull({})) === true);
  check("  and an absent object", withinLimit(1, totalFromPull(undefined)) === true);
}

console.log("\nno limit means no filtering, and that is the default");
{
  const rows = [
    { pending: ["a", "b", "c", "d", "e"] },
    { pending: ["a"] },
  ];
  check("null keeps everything", keepWithinLimit(rows, null).length === 2);
  check("  as does undefined", keepWithinLimit(rows, undefined).length === 2);
  // Zero and negatives are not a cap of zero, they are somebody's empty input.
  // Reading them as "keep nothing" would empty the summary silently.
  check("  and so does a nonsense value", keepWithinLimit(rows, 0).length === 2);
}

console.log("\nand a limit keeps exactly the ones at or under it");
{
  const rows = [
    { pending: ["me"] },
    { pending: ["me", "carol"] },
    { pending: ["me", "carol", "dave"] },
    { pending: ["me"], pendingTeams: ["platform"] },
  ];

  check("only me", keepWithinLimit(rows, 1).length === 1);
  check("  me and one other, which the team row also matches",
    keepWithinLimit(rows, 2).length === 3, keepWithinLimit(rows, 2));
  check("  and at three, everything here", keepWithinLimit(rows, 3).length === 4);

  // The boundary is inclusive: "at most three of us" keeps a review with
  // exactly three, which is what the wording on the control promises.
  check("  the limit is inclusive", withinLimit(3, 3) === true && withinLimit(3, 4) === false);
}

console.log("\nthe three screens read the one rule");
{
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

  // The notification path keeps its own function name, but must not keep its
  // own arithmetic: that is how the summary and the request come to disagree
  // about the same pull request.
  const content = read("src/services/devAlertContent.ts");
  check("the notification delegates rather than counting again",
    /from "\.\/reviewerLimit"/.test(content)
      && !/1 \+ counts\.reviewers\.length/.test(content), content.slice(0, 0));

  check("  the daily summary applies it to the review list",
    /keepWithinLimit\([\s\S]{0,200}digest\.reviewerLimit\)/.test(content));

  // The queue filters in the browser, from the same `pending` list the row
  // already carries, so it needs no new endpoint and no second rule.
  const page = read(path.join("..", "frontend", "src", "pages", "MyWorkPage.tsx"));
  check("  and the queue counts the same way, on the rows it already has",
    /pending/.test(page) && /reviewerLimit/i.test(page));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
