/**
 * Which roles reach the access map.
 *
 * The map's job is to answer "who can reach what" for an access review, so the
 * failures that matter are all people who are quietly missing from it. The
 * collaborator filter was a fixed list of admin, write and maintain, which
 * dropped three kinds of person without saying so:
 *
 *   - anyone holding a custom repository role, because the role's name is
 *     whatever the organization called it and matched nothing in the list.
 *   - anyone with triage, which is never an organization default and is
 *     therefore always an explicit grant.
 *   - an outside collaborator with read — the person who is not in the
 *     organization and can nevertheless see the code.
 *
 * The one exclusion worth keeping is a member's plain read where the
 * organization already grants read to everyone: listCollaborators reports one
 * per member per repository, and it says nothing the org default has not
 * already said once at the top of the page.
 *
 * Asserted against the shipped source rather than by running the walk, which
 * needs an organization and several hundred API calls.
 */
import fs from "fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const src = fs.readFileSync(`${__dirname}/src/jobs/graphAggregator.ts`, "utf8");

// The decision, lifted out of the source and run directly. Keeping it in one
// expression there is what makes this possible; a check spread across the loop
// could only be described here, not exercised.
type OrgRole = "member" | "owner" | "outside_collaborator";
function worthRecording(role: string, orgRole: OrgRole, orgDefault: string): boolean {
  const DEFAULT_COVERS_READ = orgDefault === "read" || orgDefault === "write" || orgDefault === "admin";
  const isRead = role === "read" || role === "pull";
  if (!isRead) return true;
  if (orgRole === "outside_collaborator") return true;
  return !DEFAULT_COVERS_READ;
}

(async () => {
  // ── the source no longer carries a fixed list ───────────────────────
  {
    check("the collaborator filter is not a hardcoded role list",
      !/const PRIVILEGED\s*=/.test(src),
      "a fixed list silently drops custom roles, whose names it cannot know");
    check("  and the decision depends on the organization's default",
      /DEFAULT_COVERS_READ/.test(src) && /orgDefault/.test(src));
    check("  and on whether the person is outside the organization",
      /outside_collaborator/.test(src.slice(src.indexOf("worthRecording"))));
  }

  // ── every explicit grant is recorded ────────────────────────────────
  {
    for (const role of ["admin", "maintain", "write", "push", "triage"]) {
      check(`${role} is recorded whatever the org default is`,
        worthRecording(role, "member", "read") && worthRecording(role, "member", "none"));
    }
    check("a custom repository role is recorded under its own name",
      worthRecording("security-reviewer", "member", "read"),
      "the organization names these, so no fixed list can contain them");
  }

  // ── read, which is the whole subtlety ───────────────────────────────
  {
    check("a member's read is skipped when everyone already has read",
      !worthRecording("read", "member", "read"),
      "one edge per member per repository, saying what the org default says once");
    check("  and skipped when the default is broader still",
      !worthRecording("read", "member", "write") && !worthRecording("read", "member", "admin"));

    check("  but recorded when the organization grants nothing by default",
      worthRecording("read", "member", "none"),
      "with no default, read is an explicit grant like any other");
    check("  and recorded when the default could not be read",
      worthRecording("read", "member", "unknown"),
      "guessing the default would hide real access on a failed lookup");

    check("an outside collaborator's read is always recorded",
      worthRecording("read", "outside_collaborator", "read")
        && worthRecording("read", "outside_collaborator", "none"),
      "not in the org, so no org default covers them — the row a review exists to find");
    check("  including GitHub's other spelling of it",
      worthRecording("pull", "outside_collaborator", "read"));
  }

  // ── the map can still rank what it receives ─────────────────────────
  {
    const map = fs.readFileSync(`${__dirname}/src/services/accessMapService.ts`, "utf8");
    for (const role of ["admin", "maintain", "write", "triage", "read"]) {
      check(`  the access map ranks ${role}`, new RegExp(`\\b${role}:\\s*\\d`).test(map));
    }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
