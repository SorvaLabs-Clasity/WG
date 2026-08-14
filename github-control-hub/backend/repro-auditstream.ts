/**
 * Setting up enterprise audit-log streaming from the app.
 *
 * This creates IAM: an OIDC provider for GitHub's audit-log issuer and a role
 * that issuer may assume. The failures worth guarding are all about who ends up
 * able to write into the bucket that exists to be the record nobody can
 * rewrite:
 *
 *   - a trust policy with no subject, which any GitHub enterprise can assume.
 *   - a slug carrying anything but a slug, interpolated into that condition.
 *   - re-running with a different enterprise and leaving the old one trusted.
 *   - reporting "set up" off the role's existence, when streaming is still
 *     switched off in GitHub and nothing has ever arrived.
 */
import {
  getStatus, setupStream, disconnectStream, trustPolicyFor, writePolicyFor, enterpriseFromTrustPolicy,
  isValidEnterpriseSlug, bucketName, roleName, OIDC_HOST, type AuditStreamDeps,
} from "./src/services/auditStreamService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const ACCOUNT = "123456789012";
const PREFIX = "github-control-hub";

function harness(over: Partial<AuditStreamDeps> = {}) {
  const calls: string[] = [];
  let trust: any = null;
  const deps: AuditStreamDeps = {
    accountId: ACCOUNT,
    prefix: PREFIX,
    getRoleTrustPolicy: async () => trust,
    listOidcProviderUrls: async () => [],
    createOidcProvider: async (u) => { calls.push(`createProvider:${u}`); return "arn:provider"; },
    createRole: async (n, t) => { calls.push(`createRole:${n}`); trust = t; return "arn:role"; },
    putRolePolicy: async (n, p) => { calls.push(`putPolicy:${p}`); },
    updateTrustPolicy: async (n, t) => { calls.push(`updateTrust`); trust = t; },
    deleteRolePolicy: async (n, p) => { calls.push(`deletePolicy:${p}`); },
    deleteRole: async (n) => { calls.push(`deleteRole:${n}`); trust = null; },
    countBucketObjects: async () => 0,
    ...over,
  };
  return { deps, calls, setTrust: (t: any) => { trust = t; } };
}

// ── the trust policy names one enterprise ─────────────────────────────
{
  const doc = trustPolicyFor(ACCOUNT, "acme-ent");
  const cond = doc.Statement[0].Condition.StringEquals;

  check("the subject is pinned to that enterprise",
    cond[`${OIDC_HOST}:sub`] === "https://github.com/acme-ent", cond);
  check("  and the audience to STS",
    cond[`${OIDC_HOST}:aud`] === "sts.amazonaws.com", cond);
  check("  the principal is this account's provider, not a wildcard",
    doc.Statement[0].Principal.Federated === `arn:aws:iam::${ACCOUNT}:oidc-provider/${OIDC_HOST}`,
    doc.Statement[0].Principal);

  // A policy trusting the issuer with no subject is assumable by any GitHub
  // enterprise on earth. That is the mistake this whole shape exists to avoid.
  check("  a subject condition is always present",
    typeof cond[`${OIDC_HOST}:sub`] === "string" && cond[`${OIDC_HOST}:sub`].length > "https://github.com/".length,
    "the role would trust every GitHub enterprise");

  check("it round-trips back to the slug",
    enterpriseFromTrustPolicy(doc) === "acme-ent", enterpriseFromTrustPolicy(doc));
  check("  and a policy without one reads as unpinned",
    enterpriseFromTrustPolicy({ Statement: [{ Effect: "Allow" }] }) === null);
}

// ── the write grant is one bucket ─────────────────────────────────────
{
  const pol = writePolicyFor(bucketName(PREFIX, ACCOUNT));
  check("the role may only put objects",
    JSON.stringify(pol.Statement[0].Action) === JSON.stringify(["s3:PutObject"]), pol.Statement[0].Action);
  check("  into this bucket alone",
    pol.Statement[0].Resource === `arn:aws:s3:::${PREFIX}-audit-log-${ACCOUNT}/*`, pol.Statement[0].Resource);
  check("  and cannot read or delete what it wrote",
    !/GetObject|DeleteObject|s3:\*/.test(JSON.stringify(pol)),
    "an append-only record it can read back or erase is not one");
}

// ── the slug is interpolated, so it is validated ──────────────────────
{
  for (const good of ["acme", "acme-ent", "a", "A1-b2"]) {
    check(`"${good}" is accepted`, isValidEnterpriseSlug(good));
  }
  for (const bad of ["", "*", "acme ent", "acme/ent", "https://github.com/acme",
                     "acme\"}", "-leading", "x".repeat(40)]) {
    check(`  ${JSON.stringify(bad)} is refused`, !isValidEnterpriseSlug(bad),
      "a value that is not a slug would widen the trust condition");
  }
}

(async () => {
  // ── first-time setup ────────────────────────────────────────────────
  {
    const { deps, calls } = harness();
    const res = await setupStream("acme-ent", deps);

    check("a fresh account gets a provider and a role",
      calls.some(c => c.startsWith("createProvider")) && calls.some(c => c.startsWith("createRole")),
      calls);
    check("  and the inline write policy", calls.some(c => c.startsWith("putPolicy")), calls);
    check("  reporting what it made", res.createdProvider && res.createdRole, res);
    check("  with the ARN the operator pastes into GitHub",
      res.roleArn === `arn:aws:iam::${ACCOUNT}:role/${PREFIX}-audit-log-stream`, res.roleArn);
  }

  // ── an existing provider is reused, not duplicated ──────────────────
  {
    const { deps, calls } = harness({
      listOidcProviderUrls: async () => [`https://${OIDC_HOST}`],
    });
    const res = await setupStream("acme-ent", deps);
    check("an existing OIDC provider is left alone",
      !calls.some(c => c.startsWith("createProvider")) && !res.createdProvider, calls);
  }

  // ── changing the enterprise moves the trust ─────────────────────────
  {
    const { deps, calls, setTrust } = harness();
    setTrust(trustPolicyFor(ACCOUNT, "old-ent"));

    await setupStream("new-ent", deps);
    check("re-running with a new slug repoints the role",
      calls.includes("updateTrust"), calls);
    check("  rather than creating a second one",
      !calls.some(c => c.startsWith("createRole")), calls);

    // Leaving the old subject in place would let the old enterprise keep
    // writing while the app reported the new one.
    const after = await getStatus(deps);
    check("  and the old enterprise no longer trusted",
      after.enterprise === "new-ent", after.enterprise);
  }

  // ── same enterprise: nothing is rewritten needlessly ────────────────
  {
    const { deps, calls, setTrust } = harness();
    setTrust(trustPolicyFor(ACCOUNT, "acme-ent"));
    await setupStream("acme-ent", deps);
    check("re-running unchanged does not touch the trust policy",
      !calls.includes("updateTrust"), calls);
  }

  // ── status tells three states apart ─────────────────────────────────
  {
    const none = await getStatus(harness().deps);
    check("no role reads as not configured",
      !none.configured && none.enterprise === null && none.roleArn === null, none);

    const { deps, setTrust } = harness();
    setTrust(trustPolicyFor(ACCOUNT, "acme-ent"));
    const ready = await getStatus(deps);
    check("a role with no objects reads as configured but not receiving",
      ready.configured && !ready.receiving, ready);

    const live = harness({ countBucketObjects: async () => 7 });
    live.setTrust(trustPolicyFor(ACCOUNT, "acme-ent"));
    const flowing = await getStatus(live.deps);
    check("  and objects in the bucket read as receiving",
      flowing.configured && flowing.receiving && flowing.objectCount === 7, flowing);

    // The distinction that matters: AWS can be perfect while streaming is
    // still switched off in GitHub, and only the object count shows it.
    check("configured is never inferred from the bucket being empty",
      ready.configured === true, "a correct setup would read as broken");
  }

  // ── a bad slug never reaches IAM ────────────────────────────────────
  {
    const { deps, calls } = harness();
    let threw = false;
    try { await setupStream('acme"}', deps); } catch { threw = true; }
    check("an invalid slug is refused before anything is created",
      threw && calls.length === 0, calls);
  }

  // ── a missing role is not an error ──────────────────────────────────
  {
    const { deps } = harness({
      getRoleTrustPolicy: async () => { throw new Error("NoSuchEntity"); },
      countBucketObjects: async () => { throw new Error("bucket gone"); },
    });
    const st = await getStatus(deps);
    check("status survives AWS refusing both lookups",
      st.configured === false && st.objectCount === 0, st);
  }

  // ── turning it off ──────────────────────────────────────────────────
  {
    const { deps, calls, setTrust } = harness({ countBucketObjects: async () => 42 });
    setTrust(trustPolicyFor(ACCOUNT, "acme-ent"));

    const res = await disconnectStream(deps);
    check("disconnecting removes the role", res.removedRole && calls.some(c => c.startsWith("deleteRole")), calls);
    check("  after its inline policy, which AWS requires first",
      calls.indexOf("deletePolicy:github-control-hub-audit-log-write") < calls.findIndex(c => c.startsWith("deleteRole")),
      calls);

    // The archive is the point of the feature. Cutting the stream must not
    // destroy what it already collected.
    check("  and nothing touches the bucket",
      !calls.some(c => /bucket|Bucket|delete.*Object/.test(c)) && res.objectsKept === 42,
      { calls, kept: res.objectsKept });

    const after = await getStatus(deps);
    check("  leaving it reading as not configured", !after.configured, after);
  }

  {
    // The OIDC provider is account-wide; another role may trust the same
    // issuer, and with nothing pointing at it, it grants nobody anything.
    const { deps, calls, setTrust } = harness();
    setTrust(trustPolicyFor(ACCOUNT, "acme-ent"));
    await disconnectStream(deps);
    check("the shared OIDC provider is left in place",
      !calls.some(c => /rovider/.test(c)), calls);
  }

  {
    const { deps, calls } = harness();   // no role to begin with
    const res = await disconnectStream(deps);
    check("disconnecting when nothing is set up is not an error",
      res.removedRole === false && !calls.some(c => c.startsWith("deleteRole")), { res, calls });
  }

  {
    // Somebody may have removed the inline policy by hand. Failing there would
    // leave the role behind and the stream still live.
    const { deps, calls, setTrust } = harness({
      deleteRolePolicy: async () => { throw new Error("NoSuchEntity"); },
    });
    setTrust(trustPolicyFor(ACCOUNT, "acme-ent"));
    const res = await disconnectStream(deps);
    check("a missing inline policy does not block removing the role",
      res.removedRole === true, { res, calls });
  }

  {
    // Off then on again, without touching GitHub.
    const { deps, setTrust } = harness();
    setTrust(trustPolicyFor(ACCOUNT, "acme-ent"));
    await disconnectStream(deps);
    await setupStream("acme-ent", deps);
    const back = await getStatus(deps);
    check("setting up again after disconnecting restores it",
      back.configured && back.enterprise === "acme-ent", back);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
