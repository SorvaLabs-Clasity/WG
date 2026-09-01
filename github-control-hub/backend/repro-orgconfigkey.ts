import fs from "node:fs";
import path from "node:path";
import { __setDocClientForTests } from "./src/utils/dynamo";

/**
 * Regression test: the configuration row has a key every process can compute.
 *
 * It was keyed on the GitHub organization's name, which two kinds of process do
 * not have. An install with no GitHub has no name at all, and DynamoDB refuses
 * an empty string as a key attribute, so every read threw. And the guardrail
 * function is kept away from GitHub credentials on purpose, so it could not
 * know the name even where one existed.
 *
 * The visible symptom was narrow and baffling: a guardrail alarm sent its email
 * and never its Teams message, because the Teams workflow URL lives in this row.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

/** A DynamoDB stand-in that records the keys it was asked for. */
function fakeDynamo(rows: Record<string, any>) {
  const gets: string[] = [];
  const puts: any[] = [];
  const client = {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      if (name.startsWith("Get")) {
        const key = cmd.input.Key.org;
        // The real service refuses this, and refusing it here is the whole
        // point: a test that quietly accepted "" would have passed throughout.
        if (key === "") throw new Error(
          "One or more parameter values are not valid. The AttributeValue for a "
          + "key attribute cannot contain an empty string value. Key: org");
        gets.push(key);
        return { Item: rows[key] };
      }
      if (name.startsWith("Put")) { puts.push(cmd.input.Item); return {}; }
      return {};
    },
  };
  return { client, gets, puts };
}

(async () => {
  process.env.ORG_CONFIG_TABLE = "test-org-config";

  console.log("\nno process ever asks for an empty key");
  {
    delete process.env.GITHUB_ORG;
    const fake = fakeDynamo({});
    const restore = __setDocClientForTests(fake.client);
    const { getOrgConfig } = await import("./src/services/orgConfigService");
    const config = await getOrgConfig();
    restore();

    check("an install with no GitHub reads a real key",
      fake.gets.length > 0 && fake.gets.every(k => k !== ""), fake.gets);
    check("  and seeds a row it can find again",
      typeof config.org === "string" && config.org.length > 0, config.org);
  }

  console.log("\nthe key does not depend on knowing the organization");
  {
    // Two processes, one of which has the name and one of which does not, must
    // land on the same row or one of them cannot see what the other wrote.
    const seeded: Record<string, any> = {};
    const withOrg = fakeDynamo(seeded);
    process.env.GITHUB_ORG = "acme";
    let restore = __setDocClientForTests(withOrg.client);
    const { getOrgConfig } = await import("./src/services/orgConfigService");
    await getOrgConfig();
    restore();

    const keyUsed = withOrg.gets[0];
    delete process.env.GITHUB_ORG;
    const withoutOrg = fakeDynamo(seeded);
    restore = __setDocClientForTests(withoutOrg.client);
    await getOrgConfig();
    restore();

    check("both processes read the same row",
      keyUsed === withoutOrg.gets[0], { withOrg: keyUsed, withoutOrg: withoutOrg.gets[0] });
    check("  and it is not the organization's name", keyUsed !== "acme", keyUsed);
  }

  console.log("\nan install that already has a row keeps it");
  {
    process.env.GITHUB_ORG = "acme";
    const fake = fakeDynamo({
      acme: { org: "acme", teamsFlow: { url: "https://flow" }, renovateBot: "renovate[bot]" },
    });
    const restore = __setDocClientForTests(fake.client);
    const { getOrgConfig } = await import("./src/services/orgConfigService");
    const config = await getOrgConfig();
    restore();
    delete process.env.GITHUB_ORG;

    check("the older row is found", config.teamsFlow?.url === "https://flow", config);
    check("  with everything else on it", config.renovateBot === "renovate[bot]", config);
    // Every writer reads the whole row and puts the whole row back, so handing
    // it out under the new key is what moves it.
    check("  and comes back under the new key, so the next write moves it",
      config.org !== "acme" && !!config.org, config.org);
  }

  console.log("\nthe reason it mattered");
  {
    // The guardrail function is deliberately not given GitHub credentials, and
    // the org name only ever reaches a process through the secret.
    const stack = fs.readFileSync(
      path.join(__dirname, "..", "infra", "cdk-stack.ts"), "utf8");
    const guardrail = stack.slice(stack.indexOf('new NodejsFunction(this, "GuardrailEnforcer"'));
    const env = guardrail.slice(0, guardrail.indexOf("bundling:"));
    check("the guardrail function is given no secret to read",
      !env.includes("SECRET_NAME"),
      "it acts on the AWS account; it has no business holding the GitHub App key");
    check("  and no organization name either", !env.includes("GITHUB_ORG"));

    const handler = fs.readFileSync(
      path.join(__dirname, "src/aws-guardrails/handler.ts"), "utf8");
    check("  so it cannot learn one at runtime",
      !/loadSecretsIntoEnv/.test(handler),
      "which is why the configuration row must not be keyed on that name");
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
