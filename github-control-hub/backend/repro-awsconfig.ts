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
  findIniProblems, describeProblems, cliCanRead, stripByteOrderMark,
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
    /UTF-16/.test(utf16) && /PowerShell/.test(utf16) && /re-saved as plain UTF-8/.test(utf16),
    utf16);

  /**
   * The report this section exists for. A UTF-8 config with a byte-order mark
   * looks perfect in every editor, and the AWS CLI refuses the whole file:
   *
   *     aws sso login --profile n8n
   *     aws: [ERROR]: Unable to parse config file: C:\Users\roni_/.aws/config
   *
   * Somebody told only that will read those lines over and over and find
   * nothing wrong with them, because there is nothing wrong with them.
   */
  const bom = describeProblems("C:\\Users\\x\\.aws\\config", "utf8-bom", []);
  check("  and so is a byte-order mark, which is invisible in every editor",
    /byte-order mark/.test(bom) && /invisible/.test(bom)
    && /Unable to parse config file/.test(bom),
    bom);

  const problems = findIniProblems("region = us-east-1\n" + CONFIG);
  const msg = describeProblems("/home/x/.aws/config", "utf8", problems);
  check("  and a stray line is quoted with its number",
    /line 1/.test(msg) && /region = us-east-1/.test(msg), msg);
  check("    and says the whole file is refused for it",
    /whole file/.test(msg), msg);
}

console.log("\nan encoding the CLI cannot read is named, and then repaired");
{
  /**
   * The whole of the second report. `readIniFile` strips a byte-order mark, so
   * a BOM'd file read *here* is flawless: the profiles list, the sections
   * parse, `findIniProblems` finds nothing. The old guard only refused UTF-16,
   * so this file passed every check, got a correct profile appended to it, and
   * the screen said so — while `aws sso login` went on refusing the entire file
   * over three bytes that were there before this app ever touched it.
   */
  check("plain UTF-8 is the only thing the CLI can read",
    cliCanRead("utf8")
    && !cliCanRead("utf8-bom") && !cliCanRead("utf16le") && !cliCanRead("utf16be"),
    "a BOM'd file parses perfectly here and is refused entirely there");

  const bomBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(CONFIG.replace(/\n/g, "\r\n"), "utf8"),
  ]);
  const file = write("repair-bom", bomBytes);
  const before = readIniFile(file);
  check("  and it is not caught by the text checks, because the text is fine",
    findIniProblems(before?.text ?? "").length === 0 && before?.encoding === "utf8-bom",
    "which is why the encoding has to be asked about separately");

  const repair = stripByteOrderMark(file);
  const after = readIniFile(file);
  check("repairing it leaves a file the CLI can read",
    after?.encoding === "utf8" && cliCanRead(after!.encoding), after?.encoding);

  /**
   * The claim being made to the user is "nothing else changed", and a claim
   * about somebody's own config file should be checked rather than asserted.
   */
  check("  with every character of it intact",
    after?.text === before?.text, { before: before?.text?.length, after: after?.text?.length });
  check("  and the CRLF line endings it had",
    after?.eol === "\r\n" && (after?.text.match(/\r\n/g) ?? []).length
      === (before?.text.match(/\r\n/g) ?? []).length);
  check("  and its profiles still read the same",
    parseProfiles(after?.text ?? "").map(p => p.name).join(",") === "eng,legacy",
    parseProfiles(after?.text ?? ""));

  check("the original is kept, because this is not our file",
    !!repair?.backup && fs.existsSync(repair!.backup)
    && fs.readFileSync(repair!.backup).equals(bomBytes),
    repair?.backup);

  // A second run must not consume the copy the first one took.
  fs.writeFileSync(file, bomBytes);
  const again = stripByteOrderMark(file);
  check("  and a second repair does not overwrite the first copy",
    !!again?.backup && again!.backup !== repair!.backup
    && fs.existsSync(repair!.backup),
    [repair?.backup, again?.backup]);

  check("a file that is already plain UTF-8 is left entirely alone",
    stripByteOrderMark(write("repair-none", CONFIG)) === null,
    "no backup, no rewrite, no mtime change on a file with nothing wrong with it");

  const utf16 = write("repair-utf16", Buffer.concat([
    Buffer.from([0xff, 0xfe]), Buffer.from(CONFIG, "utf16le"),
  ]));
  stripByteOrderMark(utf16);
  const converted = readIniFile(utf16);
  check("the PowerShell case is the same repair",
    converted?.encoding === "utf8" && parseProfiles(converted?.text ?? "").length === 2,
    converted?.encoding);
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
  check("  but repairs an encoding rather than refusing over it",
    /stripByteOrderMark/.test(writerBody) && /cliCanRead/.test(writerBody),
    "refusing left somebody with an exact diagnosis and no way to act on it");
  check("    and says so, since it is an edit to a file we did not write",
    /repaired/.test(writerBody) && /backup/.test(writerBody));

  /**
   * `aws sso login` on Windows, which is where the second half of the report
   * lives: "A browser tab opened for AWS SSO" and nothing opened.
   *
   * Two separate causes, both of them silent.
   */
  const loginRoute = auth.slice(auth.indexOf('router.post("/aws-sso-login"'));
  const loginBody = loginRoute.slice(0, loginRoute.indexOf("\nrouter."));

  /**
   * The installer ships `aws.exe`. There is no `aws.cmd` for AWS CLI v2 — and
   * since the CVE-2024-27980 fix, Node refuses to spawn a `.cmd` at all without
   * a shell, by throwing *synchronously*, which the `error` listener below it
   * could never have caught. In an async Express 4 handler that is an unhandled
   * rejection and a request that never answers, so the browser kept waiting and
   * the screen kept claiming a tab had opened.
   */
  check("Windows is not asked to spawn a .cmd, which Node now refuses outright",
    !/aws\.cmd"/.test(auth) || /aws\.exe/.test(auth),
    "spawn('aws.cmd') without a shell throws EINVAL on Node 18.20.2 and later");
  check("  and the executable is looked for where the installer puts it",
    /AWSCLIV2/.test(auth) && /aws\.exe/.test(auth));
  check("  with the spawn inside the try, since it throws before there is a child",
    /try \{\s*child = spawn\(/.test(loginBody),
    "Express 4 does not catch an async throw: the request simply never answers");

  /**
   * stdio: "ignore" was the other half. The CLI said exactly what was wrong —
   * "Unable to parse config file" — into a closed pipe.
   */
  check("the CLI's stderr is kept rather than discarded",
    /stdio: \["ignore", "ignore", "pipe"\]/.test(loginBody) && /stderr \+=/.test(loginBody),
    'stdio: "ignore" is how the CLI\'s own diagnosis went missing');
  check("  and an immediate exit is reported as the failure it is",
    /child\.once\("exit"/.test(loginBody) && /stopped straight away/.test(loginBody),
    "a process that is already dead was being reported as \"check your browser\"");
  check("the config is checked here before the CLI is asked to read it",
    /findIniProblems/.test(loginBody) && /AWS_PROFILE_NOT_FOUND/.test(loginBody),
    "so the reason arrives in the app, attached to the button that caused it");

  /**
   * And the state the report actually came from: a profile that already exists
   * in a file the CLI refuses. That person never goes near "create a profile",
   * so the repair on the writer does not reach them, and a diagnosis they
   * cannot act on is where they were already stuck.
   */
  const repairRoute = auth.slice(auth.indexOf('router.post("/aws-config-repair"'));
  const repairBody = repairRoute.slice(0, repairRoute.indexOf("\n/**"));
  check("an existing profile in a refused file can be rescued without the writer",
    auth.includes('router.post("/aws-config-repair"') && /stripByteOrderMark/.test(repairBody),
    "otherwise the only path to the repair is creating a profile you already have");
  check("  and a file that is broken for two reasons does not report success",
    /stillUnusable/.test(repairBody),
    "fixing the encoding of a file with a stray line in it changes nothing");
  check("  and the list says whether the app can act, not just what is wrong",
    /fixable/.test(listerBody),
    "a button offered for a stray line would be a button that cannot work");
}

console.log("\nand the screen says it rather than showing an empty list");
{
  const login = fs.readFileSync("../frontend/src/pages/LoginPage.tsx", "utf8");
  check("the login page renders the reason the file is unusable",
    /configUnusable/.test(login) && /cannot be parsed/.test(login));
  check("  and names the file behind \"no profiles on this machine\"",
    /Read from <span className="font-mono/.test(login),
    "that claim is about one specific file, and people have more than one");

  /**
   * "A browser tab opened for AWS SSO" was set before the request went out, so
   * it was never a report of anything. It appeared on the click and stayed
   * through a backend that answered with a reason, and through a backend that
   * did not answer at all.
   */
  const handler = login.slice(login.indexOf("const handleAwsSsoLogin"));
  const handlerBody = handler.slice(0, handler.indexOf("\n  };"));
  check("the \"a browser tab opened\" claim waits until the sign-in has started",
    handlerBody.indexOf("await triggerAwsSsoLogin") < handlerBody.indexOf("setAwsSsoStarted(true)"),
    "set before the call, it was a promise about the future rather than a report");

  const api = fs.readFileSync("../frontend/src/api/auth.ts", "utf8");
  check("  and the request cannot hang there forever",
    /AbortSignal\.timeout/.test(api) && /stopped waiting/.test(api),
    "the observable bug was a button that did nothing, indefinitely");
}

console.log("\nand the window has the zoom keys every other window has");
{
  const zoom = fs.readFileSync("../desktop/src/zoom.ts", "utf8");
  const main = fs.readFileSync("../desktop/src/main.ts", "utf8");

  /**
   * There was no zoom at all, and the cause is `Menu.setApplicationMenu(null)`:
   * Ctrl/Cmd +/- are menu *roles* in Electron, so throwing the menu away to get
   * a chrome-less frame throws the accelerators away with it.
   */
  check("zoom is wired to the window rather than to a menu",
    /before-input-event/.test(zoom) && /Menu\.setApplicationMenu\(null\)/.test(main),
    "a hidden menu would reappear on Windows every time Alt is pressed");
  check("  and installed on the window before its first load",
    main.indexOf("installZoom(mainWindow)") < main.indexOf("mainWindow.loadURL"),
    "applied after, a remembered zoom level is a visible jump");
  check("Cmd on macOS, Ctrl everywhere else",
    /darwin" \? input\.meta : input\.control/.test(zoom));
  check("  and \"=\" counts as zoom in, because \"+\" costs a Shift",
    /case "\+": case "=":/.test(zoom),
    "nobody presses Ctrl+Shift+= on purpose; they press control plus");
  check("  and \"_\" counts as zoom out, for a Shift not yet let go of",
    /case "-": case "_":/.test(zoom));
  check("the keypress does not also reach the page",
    /event\.preventDefault\(\)/.test(zoom),
    'without it a "-" zooms out and gets typed into the field as well');
  check("the level is clamped, since this layout has a 1024-wide minimum",
    /MIN_LEVEL/.test(zoom) && /MAX_LEVEL/.test(zoom) && /clamp/.test(zoom));
  const prefsFile = zoom.match(/const FILE = path\.join\(DIR, "([^"]+)"\)/)?.[1];
  check("and it is remembered somewhere the backend does not also write",
    prefsFile === "window.json",
    prefsFile ?? "read-modify-write from two processes loses whichever key lost the race");
}

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
