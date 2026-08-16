/**
 * Listing organization members, for picking a person instead of typing one.
 *
 * Run from github-control-hub/backend:  npx tsx repro-orgmembers.ts
 *
 * The failure this exists for is not an exception, it is a silence. A free-text
 * login box accepts any string, and plenty of strings are real GitHub accounts
 * belonging to strangers — so a typo does not fail, it names somebody outside
 * the organization, renders their photograph beside it, and stores a mute that
 * can never match anybody. The mute looks set. The person it was meant for goes
 * on being reminded.
 *
 * Two things have to hold for the fix to be worth anything:
 *
 *   - the list is *complete*. Reading page one returns a hundred people and
 *     looks entirely successful, so an org of a hundred and twenty quietly has
 *     twenty people who cannot be chosen.
 *   - membership is compared the way GitHub compares logins, which is without
 *     regard to case. Rejecting "Alice" because the list says "alice" refuses a
 *     real member over a capital letter.
 */
import {
  listOrgMembers, isOrgMember, type MembersDeps, type OrgMember,
} from "./src/services/orgMembersService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** A fake org of `total` people, served in pages, counting the requests made. */
function orgOf(total: number, extra: Array<Record<string, unknown>> = []) {
  const all = [
    ...Array.from({ length: total }, (_, i) => ({
      login: `person${String(i).padStart(3, "0")}`,
      avatar_url: `https://avatars.example/${i}`,
      type: "User",
    })),
    ...extra,
  ];
  const calls: number[] = [];
  const deps: MembersDeps = {
    listPage: async (_org, page, perPage) => {
      calls.push(page);
      return all.slice((page - 1) * perPage, page * perPage);
    },
  };
  return { deps, calls };
}

(async () => {
  // ── completeness ──────────────────────────────────────────────────────
  {
    const { deps, calls } = orgOf(250);
    const members = await listOrgMembers(deps, "example-org");
    check("everyone is returned, not the first page", members.length === 250, members.length);
    check("  which took three pages", calls.length === 3, calls);

    const small = orgOf(7);
    const few = await listOrgMembers(small.deps, "example-org");
    check("a short first page is the last page", few.length === 7 && small.calls.length === 1,
      { got: few.length, calls: small.calls });
  }
  {
    // The boundary that hides the paging bug: exactly one full page. Stopping
    // because "the page was full but the next is empty" must still cost the one
    // extra request rather than assuming there is more, or assuming there is not.
    const { deps, calls } = orgOf(100);
    const members = await listOrgMembers(deps, "example-org");
    check("exactly one full page returns all hundred", members.length === 100, members.length);
    check("  and the empty page after it adds nobody", calls.length === 2, calls);
  }
  {
    const empty: MembersDeps = { listPage: async () => [] };
    check("an org with nobody in it is an empty list, not an error",
      (await listOrgMembers(empty, "example-org")).length === 0);
  }

  // ── what is filtered out ──────────────────────────────────────────────
  {
    const { deps } = orgOf(3, [
      { login: "some-app[bot]", avatar_url: "https://avatars.example/bot", type: "Bot" },
      { login: "", avatar_url: null, type: "User" },
      { login: "PERSON000", avatar_url: "https://avatars.example/dup", type: "User" },
    ]);
    const members = await listOrgMembers(deps, "example-org");
    const logins = members.map(m => m.login);
    check("a bot is never somebody to stop reminding", !logins.some(l => l.includes("[bot]")), logins);
    check("a blank login is dropped rather than listed", !logins.includes(""), logins);
    check("the same person in two casings appears once",
      logins.filter(l => l.toLowerCase() === "person000").length === 1, logins);
    check("sorted, so the list reads the same every time",
      logins.join(",") === [...logins].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).join(","),
      logins);
  }
  {
    const { deps } = orgOf(0, [{ login: "nophoto", type: "User" }]);
    const [m] = await listOrgMembers(deps, "example-org");
    check("a member with no avatar is still a member", m?.login === "nophoto" && m?.avatarUrl === null, m);
  }

  // ── membership comparison ─────────────────────────────────────────────
  {
    const members: OrgMember[] = [
      { login: "alice", avatarUrl: null },
      { login: "Bob-Smith", avatarUrl: null },
    ];
    check("a member is recognised", isOrgMember("alice", members));
    check("a different casing is the same person", isOrgMember("ALICE", members));
    check("  and in the other direction too", isOrgMember("bob-smith", members));
    check("surrounding space does not make a stranger", isOrgMember("  alice  ", members));

    // The whole point: a real GitHub account that is not in this organization.
    check("somebody outside the organization is refused", !isOrgMember("torvalds", members));
    check("a near miss is refused", !isOrgMember("alicee", members));
    check("empty is refused rather than matching everybody", !isOrgMember("", members));
    check("whitespace alone is refused", !isOrgMember("   ", members));
    check("nobody is a member of an empty org", !isOrgMember("alice", []));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
