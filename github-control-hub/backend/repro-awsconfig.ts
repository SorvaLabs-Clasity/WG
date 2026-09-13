/**
 * Reading `~/.aws/config` on a machine that is not the one it was written on.
 *
 * Three reports, all the same shape: "none of my SSO profiles show up", on
 * Windows, on machines whose profiles work perfectly from a terminal. Followed
 * by a profile created from the app, and then
 *
 *     aws sso login --profile nin
 *     aws: [ERROR]: Unable to parse config file: C:\Users\roni_/.aws/config
 *
 * which reads as though the app wrote something invalid. It did not. Four
 * separate things were wrong, and each one on its own produces exactly "there
 * are no profiles here":
 *
 *   1. A read failure answered 200 with an empty list and the reason in a
 *      field nothing rendered, so "I could not read the file" and "this
 *      machine has no profiles" were the same screen.
 *   2. The list and the writer built the path from `os.homedir()` while the
 *      region lookup honoured `AWS_CONFIG_FILE`. Where that variable is set,
 *      the app listed one file and the CLI read another — and *wrote* new
 *      profiles into the one the CLI does not read.
 *   3. A UTF-16 config, which is what PowerShell 5.1 writes with `>` or
 *      `Set-Content`, read as UTF-8 gives mojibake rather than an error. No
 *      header matches, so the honest report is "no profiles", and the same
 *      file is what the CLI is refusing.
 *   4. Appending to a file the CLI already cannot parse, which turns somebody
 *      else's broken line into this app's fault.
 *
 * The path and encoding cases are run against real files on disk rather than
 * against strings, because the bug was in the decode and a string fixture
 * cannot have an encoding.
 *
 * Run:  npx tsx repro-awsconfig.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configFilePath, credentialsFilePath, readIniFile, parseProfiles,
  findIniProblems, describeProblems,
} from "./src/services/awsConfigFile";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const CONFIG = [
  "[sso-session corp]",
  "sso_start_url = https://corp.awsapps.com/start",
  "sso_region = us-east-1",
  "sso_registration_scopes = sso:account:access",
  "",
  "[profile eng]",
  "sso_session = corp",
  "sso_account_id = 123456789012",
  "sso_role_name = AdministratorAccess",
  "region = us-east-1",
  "",
  "[profile legacy]",
  "region = eu-west-1",
  "",
].join("\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awscfg-"));
const write = (name: string, buf: Buffer | string) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, buf);
  return p;
};

(async () => {

console.log("the file the CLI reads is the file we read");
{
  const before = process.env.AWS_CONFIG_FILE;
  const beforeCreds = process.env.AWS_SHARED_CREDENTIALS_FILE;
  try {
    delete process.env.AWS_CONFIG_FILE;
    check("with nothing set, it is the one under the home directory",
      configFilePath() === path.join(os.homedir(), ".aws", "config"));

    /**
     * The variable every AWS SDK and the CLI resolve first. Ignoring it meant
     * listing profiles from a file the CLI does not read, and writing new ones
     * into it — so the profile existed, the screen said so, and
     * `aws sso login --profile <it>` could not find it.
     */
    process.env.AWS_CONFIG_FILE = path.join(tmp, "elsewhere");
    check("AWS_CONFIG_FILE wins, as it does for the CLI",
      configFilePath() === path.join(tmp, "elsewhere"),
      "listing one file and writing into another is how a created profile goes missing");

    // Shells hand this over expanded; a value set in a file or a GPO does not.
    process.env.AWS_CONFIG_FILE = "~/somewhere/config";
    check("  and a leading ~ is expanded, not taken literally",
      configFilePath() === path.join(os.homedir(), "somewhere", "config"));

    process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(tmp, "creds");
    check("  the credentials file follows the same rule",
      credentialsFilePath() === path.join(tmp, "creds"));
  } finally {
    if (before === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = before;
    if (beforeCreds === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    else process.env.AWS_SHARED_CREDENTIALS_FILE = beforeCreds;
  }
}

console.log("\nand it is read in whatever it was written in");
{
  const cases: Array<[string, Buffer, string]> = [
    ["LF, as a Mac or Linux writes it", Buffer.from(CONFIG, "utf8"), "utf8"],
    ["CRLF, as Windows writes it", Buffer.from(CONFIG.replace(/\n/g, "\r\n"), "utf8"), "utf8"],
    ["CRLF with a UTF-8 BOM", Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CONFIG.replace(/\n/g, "\r\n"), "utf8"),
    ]), "utf8-bom"],
    // PowerShell 5.1, still the default shell on Windows, writes this for
    // `... > config` and for Set-Content with no -Encoding.
    ["UTF-16LE, as PowerShell writes it", Buffer.concat([
      Buffer.from([0xff, 0xfe]), Buffer.from(CONFIG.replace(/\n/g, "\r\n"), "utf16le"),
    ]), "utf16le"],
  ];

  for (const [label, bytes, expected] of cases) {
    const file = write(`config-${expected}-${label.length}`, bytes);
    const read = readIniFile(file);
    check(`  ${label}`, read?.encoding === expected, read?.encoding);
    const profiles = parseProfiles(read?.text ?? "");
    check(`    and its profiles are found`,
      profiles.length === 2 && profiles[0].name === "eng" && profiles[0].type === "sso",
      profiles);
    check(`    with the start URL from the session block`,
      profiles[0]?.ssoStartUrl === "https://corp.awsapps.com/start",
      profiles[0]?.ssoStartUrl);
  }

  // A machine that has never run the CLI. An ordinary state, and not the same
  // thing as a file that cannot be read — which throws, so the caller can say
  // which of the two it is.
  check("a missing file is null rather than an error",
    readIniFile(path.join(tmp, "does-not-exist")) === null);

  const crlf = readIniFile(write("eol-crlf", CONFIG.replace(/\n/g, "\r\n")));
  const lf = readIniFile(write("eol-lf", CONFIG));
  check("the line ending is reported, so an appended block can match it",
    crlf?.eol === "\r\n" && lf?.eol === "\n", [crlf?.eol, lf?.eol]);
}

console.log("\na second section does not steal the profile above it");
{
  // `[profile eng]` then `[sso-session corp]` with its own `region` would have
  // been read as the profile's, because only a `[profile` header ended a
  // profile and any other section was skipped line by line.
  const reordered = [
    "[profile eng]",
    "sso_session = corp",
    "sso_account_id = 123456789012",
    "",
    "[sso-session corp]",
    "sso_start_url = https://corp.awsapps.com/start",
    "region = ap-southeast-2",
    "",
  ].join("\n");
  const [eng] = parseProfiles(reordered);
  check("a key under [sso-session] is not read as the profile's",
    eng?.region === undefined, eng?.region);
  check("  while the session's start URL still reaches the profile",
    eng?.ssoStartUrl === "https://corp.awsapps.com/start");
}

console.log("\nwhat the CLI will refuse, said before it refuses it");
{
  check("a good file has nothing to report", findIniProblems(CONFIG).length === 0);
  check("  and CRLF is not a problem", findIniProblems(CONFIG.replace(/\n/g, "\r\n")).length === 0);
  check("  nor are comments", findIniProblems("; set by IT\n# and me\n" + CONFIG).length === 0);

  /**
   * configparser, which is what the CLI uses, raises on each of these and
   * refuses the *whole* file — so one stray line makes every profile in it
   * stop working, which is exactly the state that reads as "the app broke my
   * config".
   */
  const stray = findIniProblems("region = us-east-1\n" + CONFIG);
  check("a setting before any section is a problem",
    stray.some(p => p.line === 1 && /before any/.test(p.why)), stray);

  const noEquals = findIniProblems(CONFIG + "\nthis is not a setting\n");
  check("  so is a line that is neither a header nor a key",
    noEquals.some(p => /neither/.test(p.why)), noEquals);

  const unclosed = findIniProblems("[profile broken\nregion = us-east-1\n");
  check("  so is a header with no closing bracket",
    unclosed.some(p => /closing/.test(p.why)), unclosed);

  const dupe = findIniProblems(CONFIG + "\n[profile eng]\nregion = us-west-2\n");
  check("  and so is the same section twice",
    dupe.some(p => /twice/.test(p.why)), dupe);

  // The forgiving reader above lists profiles from a file the CLI rejects, so
  // the two answers are genuinely different and both are worth having.
  check("and a file can list profiles here while the CLI refuses it",
    parseProfiles("region = us-east-1\n" + CONFIG).length === 2
    && findIniProblems("region = us-east-1\n" + CONFIG).length > 0,
    "which is why this is reported next to the list rather than instead of it");
}

console.log("\nand the message names the file, the line and the fix");
{
  const utf16 = describeProblems("C:\\Users\\x\\.aws\\config", "utf16le", []);
  check("a UTF-16 file is explained, since nothing about it looks wrong",
    /UTF-16/.test(utf16) && /PowerShell/.test(utf16) && /Set-Content -Encoding utf8/.test(utf16),
    utf16);

  const problems = findIniProblems("region = us-east-1\n" + CONFIG);
  const msg = describeProblems("/home/x/.aws/config", "utf8", problems);
  check("  and a stray line is quoted with its number",
    /line 1/.test(msg) && /region = us-east-1/.test(msg), msg);
  check("    and says the whole file is refused for it",
    /whole file/.test(msg), msg);
}

console.log("\nthe routes go through it, all three of them");
{
  const auth = fs.readFileSync("src/routes/auth.ts", "utf8");

  check("nothing builds the config path by hand any more",
    !/path\.join\(os\.homedir\(\), "\.aws"/.test(auth),
    "three call sites disagreeing about which file is the bug this closes");

  check("  the list, the writer and the region lookup all ask for it",
    (auth.match(/configFilePath\(\)/g) ?? []).length >= 3,
    auth.match(/configFilePath\(\)/g));

  /**
   * The read failure that was answered 200 with an empty list. The screen said
   * "No SSO profiles on this machine yet" — an invitation to create one — when
   * what it meant was that it could not read the file, where creating one will
   * not help.
   */
  const lister = auth.slice(auth.indexOf('router.get("/aws-profiles"'));
  const listerBody = lister.slice(0, lister.indexOf("\nrouter."));
  check("a failed read is answered as a failure, not as an empty list",
    /res\.status\(500\)/.test(listerBody),
    "200 with { profiles: [] } is indistinguishable from a machine with none");
  check("  and the file it read is named either way",
    (listerBody.match(/configPath/g) ?? []).length >= 3);

  /**
   * Appending to a file the CLI cannot parse produces the worst report
   * available: the screen says the profile was created, and the CLI answers
   * "Unable to parse config file", which sounds like this app's doing.
   */
  const writer = auth.slice(auth.indexOf('router.post("/aws-sso-create-profile"'));
  const writerBody = writer.slice(0, writer.indexOf("\nrouter."));
  check("the writer refuses a file the CLI cannot parse",
    /AWS_CONFIG_UNPARSEABLE/.test(writerBody) && /findIniProblems/.test(writerBody),
    "a correct profile in an unreadable file is worse than no profile");
  check("  and writes in the line ending the file already uses",
    /file\?\.eol/.test(writerBody),
    "LF spliced into a CRLF file renders as one line in Notepad");
}

console.log("\nand the screen says it rather than showing an empty list");
{
  const login = fs.readFileSync("../frontend/src/pages/LoginPage.tsx", "utf8");
  check("the login page renders the reason the file is unusable",
    /configUnusable/.test(login) && /cannot be parsed/.test(login));
  check("  and names the file behind \"no profiles on this machine\"",
    /Read from <span className="font-mono/.test(login),
    "that claim is about one specific file, and people have more than one");
}

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
