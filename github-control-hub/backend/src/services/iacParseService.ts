/**
 * What the source says a resource should be.
 *
 * Half of drift detection. AWS can tell you a security group allows port 22;
 * only the source can tell you whether anybody asked for that.
 *
 * ## Why this parses rather than plans
 *
 * The precise answer is `terraform plan`, which needs the state file, the
 * providers, credentials for every backend and a working directory — none of
 * which a read-only app has or should have. So this reads the declaration
 * instead, which is enough for the question actually being asked: *is the thing
 * in AWS the thing somebody wrote down?*
 *
 * The cost of that choice is stated rather than hidden. A value computed from a
 * variable, a `for_each`, or a module input is **unresolved**, and an unresolved
 * declaration is never reported as drift. Guessing what `var.ssh_cidr` expands
 * to is how a drift report becomes noise, and a drift report nobody believes is
 * worse than none.
 */

export interface ParsedRule {
  /** `ingress` or `egress`. */
  direction: "ingress" | "egress";
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
  cidrs: string[];
  /** True when a value came from a variable or expression rather than a literal. */
  unresolved: boolean;
}

export interface ParsedSecurityGroup {
  /** The Terraform resource label, not the AWS name. */
  label: string;
  /** `name` or `name_prefix` when written literally. */
  name: string | null;
  rules: ParsedRule[];
  /** Anything the parse could not resolve, in words. */
  notes: string[];
}

/** A value that is not a literal — a variable, a local, an interpolation. */
const isExpression = (v: string) =>
  /\$\{|\bvar\.|\blocal\.|\bdata\.|\bmodule\.|\beach\.|\bcount\./.test(v);

/**
 * Strip comments before anything else looks at the text.
 *
 * A commented-out ingress block is not a declaration. Counting one would report
 * drift against a rule somebody deliberately turned off, which is precisely
 * backwards.
 */
export function stripComments(hcl: string): string {
  return hcl
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*(#|\/\/).*$/gm, "");
}

/** The body of every `block "type" "label" { … }`, balanced by brace depth. */
export function findBlocks(
  hcl: string, keyword: string,
): Array<{ labels: string[]; body: string }> {
  const out: Array<{ labels: string[]; body: string }> = [];
  // Preceded by whitespace or an opening brace, not only by a newline.
  //
  // HCL is commonly formatted one attribute per line and is not required to be.
  // Requiring a line start meant `resource "x" { ingress { … } }` parsed as a
  // group with no rules at all — and a group with no declared rules makes every
  // live rule look like an undeclared change. The parse did not fail; it
  // produced a confident, wrong drift report.
  //
  // The character class also stops `dynamic "ingress"` matching a search for
  // `ingress`, since there the word is preceded by a quote.
  const head = new RegExp(`(?:^|[\\s{])${keyword}((?:\\s+"[^"]*")*)\\s*\\{`, "g");

  let m: RegExpExecArray | null;
  while ((m = head.exec(hcl))) {
    // Group 1, not 2: the prefix that precedes the keyword is non-capturing.
    const labels = [...m[1].matchAll(/"([^"]*)"/g)].map(x => x[1]);
    // Brace counting rather than a lazy regex: a nested block would end the
    // match at the first `}`, silently truncating the rules inside.
    let depth = 1;
    let i = head.lastIndex;
    for (; i < hcl.length && depth > 0; i++) {
      if (hcl[i] === "{") depth++;
      else if (hcl[i] === "}") depth--;
    }
    if (depth !== 0) continue;   // unbalanced; refuse rather than half-parse
    out.push({ labels, body: hcl.slice(head.lastIndex, i - 1) });
    head.lastIndex = i;
  }
  return out;
}

/**
 * One attribute's value, stopping where the value stops.
 *
 * The first version took everything to the end of the line, which is right for
 * the formatted HCL people mostly write and wrong for the single-line form,
 * which is equally valid:
 *
 *     ingress { from_port = 1 to_port = 1 protocol = "tcp" }
 *
 * There, `from_port` swallowed the rest of the line and the port came back as
 * the digits of every value concatenated. It did not fail — it produced a
 * number, compared it, and reported the real rule as undeclared drift.
 *
 * So the value is matched by its own shape instead: a quoted string, a
 * bracketed list, or a bare token ending at whitespace or a closing brace.
 */
function attribute(body: string, key: string): string | null {
  const m = new RegExp(
    `(?:^|[\\s{])${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\]|[^\\s}]+)`,
  ).exec(body);
  return m ? m[1].trim() : null;
}

function listValues(raw: string | null): { values: string[]; unresolved: boolean } {
  if (!raw) return { values: [], unresolved: false };
  if (isExpression(raw)) return { values: [], unresolved: true };
  const inner = /\[([\s\S]*)\]/.exec(raw)?.[1] ?? raw;
  return {
    values: [...inner.matchAll(/"([^"]*)"/g)].map(m => m[1]),
    unresolved: false,
  };
}

function numberValue(raw: string | null): { value: number | null; unresolved: boolean } {
  if (!raw) return { value: null, unresolved: false };
  if (isExpression(raw)) return { value: null, unresolved: true };
  const n = Number(raw.replace(/[^0-9-]/g, ""));
  return Number.isFinite(n) ? { value: n, unresolved: false } : { value: null, unresolved: true };
}

/**
 * Security groups declared in a Terraform file.
 *
 * Covers the inline `ingress {}` form. The separate
 * `aws_security_group_rule` resource is deliberately **not** merged in: it can
 * live in another file or another module entirely, so treating a group's inline
 * rules as its complete set when such a resource exists would report drift for
 * every rule declared the other way. Where one is seen, the group is marked
 * unresolved and reports nothing.
 */
export function parseSecurityGroups(hcl: string): ParsedSecurityGroup[] {
  const text = stripComments(hcl);
  const separateRules = /resource\s+"aws_security_group_rule"/.test(text);

  return findBlocks(text, "resource")
    .filter(b => b.labels[0] === "aws_security_group")
    .map(b => {
      const notes: string[] = [];
      const nameRaw = attribute(b.body, "name") ?? attribute(b.body, "name_prefix");
      const name = nameRaw && !isExpression(nameRaw)
        ? nameRaw.replace(/^"|"$/g, "")
        : null;
      if (nameRaw && isExpression(nameRaw)) {
        notes.push("The group's name is built from a variable, so it cannot be matched by name.");
      }

      const rules: ParsedRule[] = [];
      for (const direction of ["ingress", "egress"] as const) {
        for (const block of findBlocks(b.body, direction)) {
          const from = numberValue(attribute(block.body, "from_port"));
          const to = numberValue(attribute(block.body, "to_port"));
          const cidrs = listValues(attribute(block.body, "cidr_blocks"));
          const protoRaw = attribute(block.body, "protocol");
          const protoUnresolved = !!protoRaw && isExpression(protoRaw);

          rules.push({
            direction,
            protocol: protoRaw && !protoUnresolved ? protoRaw.replace(/^"|"$/g, "") : "unknown",
            fromPort: from.value, toPort: to.value, cidrs: cidrs.values,
            unresolved: from.unresolved || to.unresolved || cidrs.unresolved || protoUnresolved,
          });
        }
        // A `dynamic "ingress"` block generates rules from a collection. What it
        // produces is unknowable without evaluating the expression.
        for (const dyn of findBlocks(b.body, "dynamic")) {
          if (dyn.labels[0] === direction) {
            notes.push(`A dynamic ${direction} block generates rules this cannot resolve.`);
          }
        }
      }

      if (separateRules) {
        notes.push(
          "This file also declares aws_security_group_rule resources, which may add rules "
          + "elsewhere, so the inline rules are not the whole picture.",
        );
      }
      return { label: b.labels[1] ?? "", name, rules, notes };
    });
}

export interface DriftFinding {
  kind: "extra" | "missing";
  /** Rendered for a person: "tcp 22 from 0.0.0.0/0". */
  rule: string;
  detail: string;
}

export interface DriftReport {
  /** Rules AWS has that source does not declare, and the reverse. */
  findings: DriftFinding[];
  /**
   * Whether the comparison can be trusted.
   *
   * False when anything in the declaration was unresolved. A partial
   * declaration compared against complete AWS state produces "extra" findings
   * for every rule the parse could not see, which is noise that reads as
   * alarming — the exact way a drift feature loses its audience.
   */
  comparable: boolean;
  notes: string[];
}

/** One rule, in a form both sides can be compared and printed as. */
export function ruleKey(protocol: string, from: number | null, to: number | null, cidr: string): string {
  const ports = from === null && to === null ? "all"
    : from === to ? String(from)
    : `${from}-${to}`;
  return `${protocol === "-1" ? "all" : protocol} ${ports} from ${cidr}`;
}

/**
 * What AWS has that nobody wrote down, and what was written down but is not there.
 *
 * Both directions matter and they mean different things. An **extra** rule is
 * something changed by hand and never captured — the case worth an alert. A
 * **missing** rule is a declaration that never applied, which is usually a
 * failed or forgotten pipeline.
 */
export function compareSecurityGroup(
  actual: { protocol: string; from: number | null; to: number | null; cidrs: string[] }[],
  declared: ParsedSecurityGroup | null,
): DriftReport {
  if (!declared) {
    return {
      findings: [], comparable: false,
      notes: ["No Terraform declaration for this group was found in any repository you can see."],
    };
  }

  const notes = [...declared.notes];
  const unresolved = declared.rules.some(r => r.unresolved);
  if (unresolved) {
    notes.push("Some declared rules use variables or expressions, which cannot be resolved here.");
  }

  const actualKeys = new Set(
    actual.flatMap(r => r.cidrs.map(c => ruleKey(r.protocol, r.from, r.to, c))));
  const declaredKeys = new Set(
    declared.rules
      .filter(r => r.direction === "ingress" && !r.unresolved)
      .flatMap(r => r.cidrs.map(c => ruleKey(r.protocol, r.fromPort, r.toPort, c))));

  // An untrustworthy comparison makes no claims.
  //
  // Emitting findings alongside `comparable: false` invites them to be shown,
  // and every one of them is suspect: a rule the parse could not resolve is
  // indistinguishable from a rule nobody declared. Reporting "somebody added
  // this by hand" about a rule that is simply written as `var.office_cidr` is
  // the single loudest way to lose an audience, and an audience that stops
  // reading the drift report is the whole feature gone.
  const comparable = !unresolved && declared.notes.length === 0;
  if (!comparable) return { findings: [], comparable: false, notes };

  const findings: DriftFinding[] = [];
  for (const key of actualKeys) {
    if (!declaredKeys.has(key)) {
      findings.push({
        kind: "extra", rule: key,
        detail: "AWS allows this and no Terraform declares it",
      });
    }
  }
  for (const key of declaredKeys) {
    if (!actualKeys.has(key)) {
      findings.push({
        kind: "missing", rule: key,
        detail: "Terraform declares this and AWS does not have it",
      });
    }
  }

  return { findings, comparable: true, notes };
}


/**
 * Drift for one security group, from its live rules and the Terraform that
 * declares it.
 *
 * Matching a live group to a declaration is the fiddly half. A Terraform block
 * names the group by `name`, which is often built from a variable, so the match
 * is attempted on the literal name and then on the resource label. Where no
 * declaration can be identified with confidence, this says so rather than
 * comparing against the wrong one — a drift report against somebody else's
 * security group is worse than no report.
 */
export function driftForSecurityGroup(
  live: { name: string; ingress: Array<{ protocol: string; from: number | null; to: number | null; cidrs: string[] }> },
  declarations: Array<{ repo: string; path: string; groups: ParsedSecurityGroup[] }>,
): DriftReport & { declaredIn: { repo: string; path: string } | null } {
  const candidates = declarations.flatMap(d =>
    d.groups.map(g => ({ ...d, group: g })));

  const byName = candidates.filter(c => c.group.name === live.name);
  const byLabel = candidates.filter(c => c.group.label === live.name);
  const matched = byName.length === 1 ? byName[0]
    : byLabel.length === 1 ? byLabel[0]
    : null;

  if (!matched) {
    return {
      findings: [], comparable: false, declaredIn: null,
      notes: candidates.length === 0
        ? ["No Terraform declaration for this group was found in any repository you can see."]
        : [
            `${candidates.length} security groups are declared in the referencing files and none `
            + `could be matched to this one by name. Comparing against the wrong declaration would `
            + `be worse than not comparing.`,
          ],
    };
  }

  return {
    ...compareSecurityGroup(live.ingress, matched.group),
    declaredIn: { repo: matched.repo, path: matched.path },
  };
}
