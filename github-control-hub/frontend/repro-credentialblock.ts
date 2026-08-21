/**
 * Pasting the credentials block from the AWS access portal.
 *
 * That dialog offers the same credentials in four shapes, and the parser used
 * to require the literal word `export` — so one of the four worked and three
 * parsed to nothing. The button then returned silently when nothing parsed, so
 * pasting a perfectly valid block did nothing at all and explained nothing:
 * indistinguishable from a dead button, which is how it was reported.
 *
 * Every shape below is what the portal actually puts on the clipboard.
 *
 * Run:  npx tsx repro-credentialblock.ts   from github-control-hub/frontend
 */
import fs from "node:fs";
import { parseExportBlock } from "./src/lib/awsCredentialBlock";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const ID = "ASIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
// Base64, and so routinely ends in `=` — which is why the split is on the first.
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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
