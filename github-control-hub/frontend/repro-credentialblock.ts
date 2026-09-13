/**
 * Pasting the credentials block from the AWS access portal.
 *
 * That dialog offers the same credentials in four shapes, and the parser used
 * to require the literal word `export`, so one of the four worked and three
 * parsed to nothing. The button then returned silently when nothing parsed, so
 * pasting a perfectly valid block did nothing at all and explained nothing:
 * indistinguishable from a dead button, which is how it was reported.
 *
 * Every shape below is what the portal actually puts on the clipboard.
 *
 * Run:  npx tsx repro-credentialblock.ts   from github-control-hub/frontend
 */
import fs from "node:fs";
import { parseExportBlock, regionFromBlock, looksLikeRegion } from "./src/lib/awsCredentialBlock";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const ID = "ASIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
// Base64, and so routinely ends in `=`, which is why the split is on the first.
const TOKEN = "IQoJb3JpZ2luX2VjEHoaCXVzLWVhc3QtMSJHMEUCIQD//w==";

const shapes: Record<string, string> = {
  "bash / zsh":
    `export AWS_ACCESS_KEY_ID="${ID}"\nexport AWS_SECRET_ACCESS_KEY="${SECRET}"\nexport AWS_SESSION_TOKEN="${TOKEN}"`,
  "Windows command prompt":
    `set AWS_ACCESS_KEY_ID=${ID}\nset AWS_SECRET_ACCESS_KEY=${SECRET}\nset AWS_SESSION_TOKEN=${TOKEN}`,
  "PowerShell":
    `$Env:AWS_ACCESS_KEY_ID="${ID}"\n$Env:AWS_SECRET_ACCESS_KEY="${SECRET}"\n$Env:AWS_SESSION_TOKEN="${TOKEN}"`,
  "credentials file":
    `[123456789012_AdministratorAccess]\naws_access_key_id=${ID}\naws_secret_access_key=${SECRET}\naws_session_token=${TOKEN}`,
};

(async () => {
  for (const [name, block] of Object.entries(shapes)) {
    const p = parseExportBlock(block);
    check(`${name}: the key and secret come through`,
      p.AWS_ACCESS_KEY_ID === ID && p.AWS_SECRET_ACCESS_KEY === SECRET,
      p);
    check(`  ${name}: the session token survives its trailing "="`,
      p.AWS_SESSION_TOKEN === TOKEN, p.AWS_SESSION_TOKEN);
  }

  // ── the shapes that are not values ──────────────────────────────────
  {
    const p = parseExportBlock(
      `[123456789012_Admin]\n# a comment\n; another\n\naws_access_key_id=${ID}\naws_secret_access_key=${SECRET}`);
    check("a profile header is not read as a credential",
      !Object.keys(p).some(k => k.includes("123456789012")), Object.keys(p));
    check("  and neither are comments or blank lines",
      Object.keys(p).sort().join(",") === "AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY",
      Object.keys(p));
  }

  {
    const p = parseExportBlock(`export AWS_DEFAULT_REGION="us-east-2"`);
    check("a region given as an env var is picked up", p.AWS_DEFAULT_REGION === "us-east-2", p);
    const q = parseExportBlock(`[p]\nregion = us-west-1`);
    check("  and the credentials-file spelling maps to the same name",
      q.AWS_DEFAULT_REGION === "us-west-1", q);
  }

  {
    check("nothing at all parses to nothing, rather than a partial value",
      Object.keys(parseExportBlock("hello, this is not credentials")).length === 0);
    check("  and unrelated variables are left out",
      parseExportBlock(`export EDITOR=vim`).EDITOR === undefined);
  }

  // Whitespace around `=` is normal in the credentials-file form.
  {
    const p = parseExportBlock(`aws_access_key_id = ${ID}\naws_secret_access_key = ${SECRET}`);
    check("spaces around the equals sign are tolerated",
      p.AWS_ACCESS_KEY_ID === ID && p.AWS_SECRET_ACCESS_KEY === SECRET, p);
  }

  // ── and the button says why, instead of doing nothing ───────────────
  {
    const page = fs.readFileSync("./src/pages/LoginPage.tsx", "utf8");
    const fn = page.slice(page.indexOf("const handlePasteBlockConnect"));
    const body = fn.slice(0, fn.indexOf("\n  };"));
    check("an unparseable block reports it rather than returning silently",
      /setNewError\(/.test(body) && body.indexOf("setNewError") < body.indexOf("return;"),
      "a silent return here is what made this look like a dead button");
    check("  and keys that AWS rejects are reported too",
      /!result\.reachable/.test(body));
  }

  /**
   * The region, which the block almost never carries.
   *
   * Reported as "it says the region cannot be found" on both platforms. The
   * paste form had no region field at all, and the access portal's blocks do
   * not include one — so the value reaching the backend was undefined, it fell
   * through to BOOT_REGION, and BOOT_REGION is undefined on every desktop
   * launch. The SDK then had no region and the first call failed with "Region
   * is missing", a sentence about the SDK rather than about the form.
   *
   * The other form's region box said "optional" next to it, which is what made
   * leaving it blank the obvious thing to do. It was never optional.
   */
  console.log("\nthe region, which a key pair cannot carry");
  {
    const portal = [
      `export AWS_ACCESS_KEY_ID="${ID}"`,
      `export AWS_SECRET_ACCESS_KEY="${SECRET}"`,
      `export AWS_SESSION_TOKEN="${TOKEN}"`,
    ].join("\n");
    check("the portal's block names no region, which is the whole problem",
      regionFromBlock(portal) === "", regionFromBlock(portal));

    // A block copied out of a credentials file does carry one, and that is
    // worth not making somebody retype.
    const fromFile = [
      "[123456789012_AdministratorAccess]",
      `aws_access_key_id = ${ID}`,
      `aws_secret_access_key = ${SECRET}`,
      "region = eu-west-2",
    ].join("\n");
    check("  a credentials-file block does, and it is found",
      regionFromBlock(fromFile) === "eu-west-2", regionFromBlock(fromFile));

    for (const spelling of ["AWS_REGION", "AWS_DEFAULT_REGION"]) {
      const block = `${portal}\nexport ${spelling}="ap-southeast-2"`;
      check(`  as is ${spelling}`,
        regionFromBlock(block) === "ap-southeast-2", regionFromBlock(block));
    }

    check("a region is recognized by shape before any round trip",
      looksLikeRegion("us-east-1") && looksLikeRegion("eu-west-2")
      && looksLikeRegion("us-gov-west-1"));
    check("  and a typo is not",
      !looksLikeRegion("us-east") && !looksLikeRegion("useast1") && !looksLikeRegion(""));
  }

  console.log("\nand it is required in both forms, because it always was");
  {
    const page = fs.readFileSync("./src/pages/LoginPage.tsx", "utf8");

    check("the paste form has a region field at all",
      (page.match(/<RegionField/g) ?? []).length === 2,
      "without one the paste path cannot succeed on a desktop machine");

    check("  and neither is labelled optional any more",
      !/<Field label="Region" optional>/.test(page),
      '"optional" is what made leaving it blank the obvious thing to do');

    for (const [name, handler] of [
      ["pasted block", "const handlePasteBlockConnect"],
      ["one field at a time", "const handleAccessKeys"],
    ] as const) {
      const fn = page.slice(page.indexOf(handler));
      const body = fn.slice(0, fn.indexOf("\n  };"));
      check(`  ${name} refuses a blank region, and says so`,
        /if \(!region\)/.test(body) && /setNewError\(/.test(body),
        "blank used to travel to the backend and come back as \"Region is missing\"");
      check(`    and refuses one that is not a region`,
        /looksLikeRegion\(region\)/.test(body));
    }

    check("  and the button is disabled until there is one",
      (page.match(/!akRegion\.trim\(\)/g) ?? []).length === 2,
      page.match(/!akRegion\.trim\(\)/g));

    /**
     * Filled in rather than merely demanded: a credentials-file block names
     * one, and a process that has already connected knows the region it
     * connected to.
     */
    check("a region already known is filled in rather than asked for",
      /regionFromBlock\(akPasteBlock\)/.test(page) && /status\?\.aws\.region/.test(page));
    check("  but never over one somebody has typed",
      /if \(regionTyped\.current\) return;/.test(page),
      "a second paste, or a status poll, would take the answer away mid-sentence");
  }

  console.log("\nand the backend does not accept what it cannot use");
  {
    const auth = fs.readFileSync("../backend/src/routes/auth.ts", "utf8");
    const route = auth.slice(auth.indexOf('router.post("/aws-access-keys"'));
    const body = route.slice(0, route.indexOf("\nrouter."));

    check("a blank region with nothing to fall back on is refused",
      /AWS_REGION_REQUIRED/.test(body) && /BOOT_REGION/.test(body),
      "it used to be accepted and fail later as \"Region is missing\"");
    check("  while a process launched with one may still omit it",
      /!region && !BOOT_REGION/.test(body),
      "that is a choice the operator made for the machine");
    check("  and a value that is not a region is named as the problem",
      /AWS_REGION_INVALID/.test(body) && /isValidRegion/.test(body));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
