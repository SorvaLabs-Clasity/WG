/**
 * Does AWS match what somebody wrote down?
 *
 * Run from github-control-hub/backend:  npx tsx repro-drift.ts
 *
 * Drift detection is easy to build and easy to make useless. The failure is not
 * a crash — it is **noise**: a report that flags twenty rules a human knows are
 * fine, read once, disbelieved, and never opened again. Every rule below exists
 * to keep a finding meaning something.
 *
 * The three ways this becomes noise, all guarded here:
 *
 *   - **Comparing against a partial parse.** A declaration built from variables
 *     cannot be resolved without running Terraform, and comparing what was
 *     resolved against complete AWS state reports every unseen rule as "extra".
 *     Unresolved therefore means *not comparable*, and nothing is reported.
 *   - **Counting a commented-out block.** A rule somebody deliberately turned
 *     off, reported as drift, is exactly backwards.
 *   - **Assuming inline rules are all the rules.** `aws_security_group_rule`
 *     resources can add rules from another file or module entirely.
 *
 * And the distinction that makes the output actionable: a rule AWS has and
 * source does not is a manual change nobody captured; a rule source has and AWS
 * does not is a pipeline that never ran. Different problems, different people.
 */
import {
  parseSecurityGroups, compareSecurityGroup, findBlocks, stripComments, ruleKey,
  driftForSecurityGroup,
} from "./src/services/iacParseService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const HTTPS_ONLY = `
resource "aws_security_group" "web" {
  name        = "production-web"
  description = "Web tier"

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`;

const actualRule = (protocol: string, from: number | null, to: number | null, cidrs: string[]) =>
  ({ protocol, from, to, cidrs });

(async () => {
  // ── the case the feature exists for ──────────────────────────────────
  {
    const [sg] = parseSecurityGroups(HTTPS_ONLY);
    check("the group is found by its literal name", sg.name === "production-web", sg.name);
    check("  with its ingress and egress rules",
      sg.rules.length === 2 && sg.rules.filter(r => r.direction === "ingress").length === 1,
      sg.rules);
    check("  and nothing unresolved", sg.rules.every(r => !r.unresolved) && sg.notes.length === 0, sg.notes);

    // AWS has 22 as well as 443. Nobody wrote 22 down.
    const report = compareSecurityGroup([
      actualRule("tcp", 443, 443, ["0.0.0.0/0"]),
      actualRule("tcp", 22, 22, ["0.0.0.0/0"]),
    ], sg);

    check("the undeclared rule is reported", report.findings.length === 1, report.findings);
    check("  as extra, not missing", report.findings[0].kind === "extra", report.findings[0]);
    check("  naming the port and where from",
      /tcp 22 from 0\.0\.0\.0\/0/.test(report.findings[0].rule), report.findings[0].rule);
    check("  and the comparison is trustworthy", report.comparable, report.notes);
  }
  {
    // The other direction: declared and never applied.
    const [sg] = parseSecurityGroups(HTTPS_ONLY);
    const report = compareSecurityGroup([], sg);
    check("a declared rule AWS does not have is missing, not extra",
      report.findings.length === 1 && report.findings[0].kind === "missing", report.findings);
    check("  which is a pipeline problem, and says so",
      /Terraform declares this and AWS does not have it/.test(report.findings[0].detail));
  }
  {
    const [sg] = parseSecurityGroups(HTTPS_ONLY);
    const report = compareSecurityGroup([actualRule("tcp", 443, 443, ["0.0.0.0/0"])], sg);
    check("a group that matches reports nothing", report.findings.length === 0, report.findings);
    check("  and is comparable", report.comparable);
  }

  // ── a partial parse must not be compared ─────────────────────────────
  {
    const withVar = `
resource "aws_security_group" "web" {
  name = "production-web"
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.office_cidr]
  }
}
`;
    const [sg] = parseSecurityGroups(withVar);
    check("a rule built from a variable is marked unresolved",
      sg.rules[0].unresolved, sg.rules[0]);

    const report = compareSecurityGroup([actualRule("tcp", 443, 443, ["10.0.0.0/8"])], sg);
    check("  so the comparison is not trustworthy", !report.comparable, report);
    check("  and says why in words",
      report.notes.some(n => /variables or expressions/.test(n)), report.notes);
    // The rule the parse could not see must not come back as "somebody added
    // this by hand", which is the single loudest way to lose an audience.
    check("  and no unresolved rule is reported as an unauthorised change",
      !report.findings.some(f => f.kind === "extra" && /10\.0\.0\.0/.test(f.rule)),
      report.findings);
  }
  {
    const dynamic = `
resource "aws_security_group" "web" {
  name = "production-web"
  dynamic "ingress" {
    for_each = var.ports
    content { from_port = ingress.value }
  }
}
`;
    const [sg] = parseSecurityGroups(dynamic);
    check("a dynamic block is noted rather than ignored",
      sg.notes.some(n => /dynamic ingress/.test(n)), sg.notes);
    check("  and makes the comparison untrustworthy",
      !compareSecurityGroup([], sg).comparable);
  }
  {
    const separate = `
resource "aws_security_group" "web" {
  name = "production-web"
  ingress { from_port = 443 to_port = 443 protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] }
}
resource "aws_security_group_rule" "ssh" {
  type = "ingress"
}
`;
    const [sg] = parseSecurityGroups(separate);
    check("rules declared as separate resources are noticed",
      sg.notes.some(n => /aws_security_group_rule/.test(n)), sg.notes);
    check("  because inline rules are then not the whole picture",
      !compareSecurityGroup([actualRule("tcp", 22, 22, ["0.0.0.0/0"])], sg).comparable);
  }
  {
    check("no declaration at all is not comparable, and says so",
      !compareSecurityGroup([actualRule("tcp", 22, 22, ["0.0.0.0/0"])], null).comparable);
    check("  rather than reporting every live rule as unauthorised",
      compareSecurityGroup([actualRule("tcp", 22, 22, ["0.0.0.0/0"])], null).findings.length === 0);
  }

  // ── a rule somebody turned off is not a rule ─────────────────────────
  {
    const commented = `
resource "aws_security_group" "web" {
  name = "production-web"
  # ingress {
  #   from_port = 22
  #   to_port   = 22
  #   protocol  = "tcp"
  #   cidr_blocks = ["0.0.0.0/0"]
  # }
  ingress { from_port = 443 to_port = 443 protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] }
}
`;
    const [sg] = parseSecurityGroups(commented);
    check("a commented-out rule is not counted", sg.rules.length === 1, sg.rules);
    // …and therefore AWS having 22 *is* drift, which is the correct reading:
    // somebody removed it from source and not from the account.
    const report = compareSecurityGroup([
      actualRule("tcp", 443, 443, ["0.0.0.0/0"]),
      actualRule("tcp", 22, 22, ["0.0.0.0/0"]),
    ], sg);
    check("  so the live rule it describes is reported as extra",
      report.findings.length === 1 && report.findings[0].kind === "extra", report.findings);

    check("block comments are stripped too",
      !stripComments("/* ingress { from_port = 22 } */").includes("ingress"));
    check("  and a url in a string survives stripping",
      stripComments('x = "https://example.invalid/a"').includes("https://example.invalid/a"));
  }

  // ── parsing that does not fall apart on nesting ──────────────────────
  {
    const nested = `
resource "aws_security_group" "a" {
  name = "one"
  ingress { from_port = 1 to_port = 1 protocol = "tcp" cidr_blocks = ["1.1.1.1/32"] }
}
resource "aws_security_group" "b" {
  name = "two"
  ingress { from_port = 2 to_port = 2 protocol = "tcp" cidr_blocks = ["2.2.2.2/32"] }
}
`;
    const groups = parseSecurityGroups(nested);
    check("two groups in one file are two groups", groups.length === 2, groups.length);
    check("  each with its own rules",
      groups[0].rules[0].fromPort === 1 && groups[1].rules[0].fromPort === 2,
      groups.map(g => g.rules.map(r => r.fromPort)));

    // A lazy regex would end the outer block at the first inner `}`.
    const blocks = findBlocks(`resource "x" "y" { a { b { } } }`, "resource");
    check("nested braces do not truncate a block",
      blocks[0].body.includes("b {"), blocks[0]?.body);

    // HCL written on one line is still HCL. Requiring a line start meant a
    // group declared inline parsed with no rules, which makes every live rule
    // look like an undeclared change.
    const inline = parseSecurityGroups(
      `resource "aws_security_group" "x" { name = "x" ingress { from_port = 8080 to_port = 8080 protocol = "tcp" cidr_blocks = ["10.0.0.0/8"] } }`);
    check("a group declared on one line still has its rules",
      inline[0]?.rules.length === 1 && inline[0].rules[0].fromPort === 8080,
      inline[0]?.rules);
    // …and a dynamic block must not be mistaken for a plain one by the same
    // relaxation, since there the word sits inside quotes.
    const dyn = parseSecurityGroups(
      `resource "aws_security_group" "y" { name = "y" dynamic "ingress" { for_each = var.p } }`);
    check("  while a dynamic block is still not read as a plain one",
      dyn[0]?.rules.length === 0 && dyn[0].notes.some(n => /dynamic ingress/.test(n)),
      { rules: dyn[0]?.rules, notes: dyn[0]?.notes });
    check("an unbalanced block is refused rather than half-parsed",
      findBlocks(`resource "x" "y" { a {`, "resource").length === 0);
    check("other resource types are ignored",
      parseSecurityGroups(`resource "aws_s3_bucket" "x" { name = "y" }`).length === 0);
  }

  // ── how a rule reads ─────────────────────────────────────────────────
  {
    check("a single port reads as one number", ruleKey("tcp", 22, 22, "0.0.0.0/0") === "tcp 22 from 0.0.0.0/0");
    check("a range reads as a range", ruleKey("tcp", 80, 443, "0.0.0.0/0") === "tcp 80-443 from 0.0.0.0/0");
    check("all protocols read as all", ruleKey("-1", null, null, "0.0.0.0/0") === "all all from 0.0.0.0/0");
  }

  // ── matching a live group to its declaration ────────────────────────
  //
  // The fiddly half. A Terraform block names the group by `name`, which is
  // often built from a variable, so a match must be attempted more than one
  // way — and where it cannot be made with confidence, comparing against the
  // wrong declaration is worse than not comparing at all.
  {
    const decls = [{ repo: "infra", path: "terraform/sg.tf", groups: parseSecurityGroups(HTTPS_ONLY) }];
    const live = {
      name: "production-web",
      ingress: [
        { protocol: "tcp", from: 443, to: 443, cidrs: ["0.0.0.0/0"] },
        { protocol: "tcp", from: 22, to: 22, cidrs: ["0.0.0.0/0"] },
      ],
    };
    const r = driftForSecurityGroup(live, decls);
    check("a group is matched to its declaration by name", r.declaredIn?.path === "terraform/sg.tf", r.declaredIn);
    check("  and the undeclared rule reported", r.findings.length === 1 && r.findings[0].kind === "extra", r.findings);
  }
  {
    // Matched by the Terraform resource label when the name is a variable.
    const varName = `
resource "aws_security_group" "production-web" {
  name = "\${var.env}-web"
  ingress { from_port = 443 to_port = 443 protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] }
}
`;
    const decls = [{ repo: "infra", path: "terraform/sg.tf", groups: parseSecurityGroups(varName) }];
    const r = driftForSecurityGroup(
      { name: "production-web", ingress: [] }, decls);
    check("a group whose name is a variable is matched by its label",
      r.declaredIn?.path === "terraform/sg.tf", r.declaredIn);
    // …but the name being a variable is itself a note, so nothing is compared.
    check("  and is still not comparable, because the name was unresolved",
      !r.comparable, r.notes);
  }
  {
    const two = `
resource "aws_security_group" "a" { name = "one" ingress { from_port = 1 to_port = 1 protocol = "tcp" cidr_blocks = ["1.1.1.1/32"] } }
resource "aws_security_group" "b" { name = "two" ingress { from_port = 2 to_port = 2 protocol = "tcp" cidr_blocks = ["2.2.2.2/32"] } }
`;
    const decls = [{ repo: "infra", path: "terraform/sg.tf", groups: parseSecurityGroups(two) }];
    const r = driftForSecurityGroup({ name: "three", ingress: [] }, decls);
    check("a group matching no declaration is not compared", !r.comparable && r.declaredIn === null, r);
    check("  and says comparing the wrong one would be worse",
      r.notes.some(n => /worse than not comparing/.test(n)), r.notes);
    check("  reporting nothing rather than guessing", r.findings.length === 0);

    const right = driftForSecurityGroup({ name: "two", ingress: [{ protocol: "tcp", from: 2, to: 2, cidrs: ["2.2.2.2/32"] }] }, decls);
    check("  while the right one still matches and agrees",
      right.comparable && right.findings.length === 0, right);
  }
  {
    const r = driftForSecurityGroup({ name: "x", ingress: [] }, []);
    check("no declarations at all says so plainly",
      r.notes.some(n => /No Terraform declaration/.test(n)), r.notes);
  }
  {
    // Two files declaring the same group name — a module used twice, or a copy
    // somebody forgot to delete. Picking the first would compare against a
    // coin flip and report drift that depends on file ordering.
    const same = `resource "aws_security_group" "web" { name = "dupe" ingress { from_port = 80 to_port = 80 protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] } }`;
    const other = `resource "aws_security_group" "web" { name = "dupe" ingress { from_port = 443 to_port = 443 protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] } }`;
    const r = driftForSecurityGroup(
      { name: "dupe", ingress: [{ protocol: "tcp", from: 80, to: 80, cidrs: ["0.0.0.0/0"] }] },
      [
        { repo: "infra", path: "a.tf", groups: parseSecurityGroups(same) },
        { repo: "infra", path: "b.tf", groups: parseSecurityGroups(other) },
      ]);
    check("two declarations of the same name are ambiguous, not a coin flip",
      !r.comparable && r.declaredIn === null, r);
    check("  and nothing is reported", r.findings.length === 0, r.findings);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
