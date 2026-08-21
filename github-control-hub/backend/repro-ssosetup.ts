/**
 * Creating an AWS SSO profile from the app.
 *
 * This writes to `~/.aws/config`, a file the app does not own. It may hold
 * profiles for work with nothing to do with this app, and the AWS CLI parses it
 * for every command that machine runs. The failures worth guarding are all
 * about what ends up in that file:
 *
 *   - a value carrying a newline and a `[`, which does not corrupt the file —
 *     it quietly defines a *second* profile the person never asked for.
 *   - overwriting or rewriting it, when the only safe edit is one that appends.
 *   - a duplicate profile or session name, which gives the CLI two definitions
 *     of one name and no way to say which was meant.
 */
import fs from "fs";
import os from "os";
import {
  isValidStartUrl, isValidRegion, isValidAccountId, isValidRoleName,
  renderProfile, alreadyDefined, pollForToken, refreshAwsConfigCache,
} from "./src/services/ssoSetupService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

(async () => {
  // ── nothing hostile reaches the file ────────────────────────────────
  {
    // The one that matters. `\n[profile admin]\n...` appended to a role name is
    // not a syntax error — it is a working profile pointing wherever the
    // attacker chose.
    const injections = [
      "Admin\n[profile evil]\nsso_role_name = Root",
      "Admin]\n[profile evil",
      "Admin\rrole",
      "Admin role",           // a space is not valid in an IAM role name
      "",
      "x".repeat(65),
    ];
    for (const bad of injections) {
      check(`a role name of ${JSON.stringify(bad.slice(0, 24))} is refused`,
        !isValidRoleName(bad));
    }
    check("a real role name is accepted", isValidRoleName("AdministratorAccess"));
    check("  including the punctuation IAM allows", isValidRoleName("dev_role-1.2+x=y,z@w"));
  }

  // ── the account id is twelve digits, and only that ──────────────────
  {
    check("twelve digits is an account id", isValidAccountId("123456789012"));
    for (const bad of ["12345678901", "1234567890123", "12345678901a", "", "123456789012\n[profile x]"]) {
      check(`  ${JSON.stringify(bad.slice(0, 20))} is not`, !isValidAccountId(bad));
    }
  }

  // ── regions, because they are written into the file too ─────────────
  {
    for (const good of ["us-east-1", "eu-west-2", "ap-southeast-4", "us-gov-west-1"]) {
      check(`${good} is a region`, isValidRegion(good));
    }
    for (const bad of ["useast1", "us-east", "us-east-1\nregion = other", "", "US-EAST-1"]) {
      check(`  ${JSON.stringify(bad.slice(0, 20))} is not`, !isValidRegion(bad));
    }
  }

  // ── the sign-in URL ─────────────────────────────────────────────────
  {
    check("an AWS access portal URL is accepted",
      isValidStartUrl("https://acme.awsapps.com/start"));
    check("  and the newer signin.aws form", isValidStartUrl("https://acme.signin.aws/platform/login"));
    check("plain http is refused", !isValidStartUrl("http://acme.awsapps.com/start"));
    check("  and so is somewhere else entirely",
      !isValidStartUrl("https://evil.example.com/start"),
      "this URL is written to the config and handed to the AWS CLI");
    check("  including a lookalike host",
      !isValidStartUrl("https://awsapps.com.evil.example/start"));
    check("  and nonsense", !isValidStartUrl("not a url"));
  }

  // ── what gets written ───────────────────────────────────────────────
  {
    const block = renderProfile({
      profileName: "work", sessionName: "work-sso",
      startUrl: "https://acme.awsapps.com/start", ssoRegion: "us-east-1",
      accountId: "123456789012", roleName: "AdministratorAccess", region: "us-east-2",
    });

    check("it declares a profile the CLI can find", /^\[profile work\]$/m.test(block));
    check("  pointing at a session, not repeating the URL per profile",
      /^sso_session = work-sso$/m.test(block) && /^\[sso-session work-sso\]$/m.test(block));
    check("  with the account and role chosen",
      /^sso_account_id = 123456789012$/m.test(block) && /^sso_role_name = AdministratorAccess$/m.test(block));
    check("  and the region the app will work in",
      /^region = us-east-2$/m.test(block));
    check("  it asks for the scope the account list needs",
      /sso_registration_scopes = sso:account:access/.test(block));
  }

  // ── an existing name is detected, not trampled ──────────────────────
  {
    const config = `[profile default]\nregion = us-east-1\n\n[profile work]\nsso_session = work-sso\n`;
    check("an existing profile is recognised", alreadyDefined(config, "profile work"));
    check("  and one that is merely similar is not", !alreadyDefined(config, "profile wor"));
    check("  nor a substring match", !alreadyDefined(config, "profile or"));
    check("  a session is looked up the same way",
      !alreadyDefined(config, "sso-session work-sso"));
  }

  // ── the route appends, and never rewrites ───────────────────────────
  {
    const src = fs.readFileSync(`${__dirname}/src/routes/auth.ts`, "utf8");
    const route = src.slice(src.indexOf('router.post("/aws-sso-create-profile"'));
    const body = route.slice(0, route.indexOf("\n/** List all AWS profiles"));

    check("the profile is appended to the config", /appendFileSync/.test(body));
    check("  and never written over it",
      !/writeFileSync/.test(body),
      "this file may hold profiles for work unrelated to this app");
    check("  refusing a name that already exists", /status\(409\)/.test(body));
    check("  and validating every value before any of it is written",
      /isValidAccountId/.test(body) && /isValidRoleName/.test(body)
        && /isValidStartUrl/.test(body) && /problems\.length/.test(body));
    check("  with the file kept private to this user", /mode: 0o600/.test(body));
  }

  // ── the endpoints are desktop-only ──────────────────────────────────
  //
  // Writing to ~/.aws/config is a thing a person's own machine may be asked to
  // do. A deployed server has no business being asked at all.
  {
    const src = fs.readFileSync(`${__dirname}/src/routes/auth.ts`, "utf8");
    for (const route of ["aws-sso-start", "aws-sso-poll", "aws-sso-create-profile"]) {
      const line = src.slice(src.indexOf(`"/${route}"`), src.indexOf(`"/${route}"`) + 200);
      check(`  /${route} is desktop-only and same-origin`,
        /serverModeGuard/.test(line) && /sameOriginOnly/.test(line));
    }
  }

  // ── the access token never leaves the backend ───────────────────────
  {
    const src = fs.readFileSync(`${__dirname}/src/routes/auth.ts`, "utf8");
    const poll = src.slice(src.indexOf('router.post("/aws-sso-poll"'));
    const body = poll.slice(0, poll.indexOf("\n/** Step three"));
    // Checked against what is *responded*, not against the whole handler — the
    // token is legitimately passed to listAccountsAndRoles a line earlier, and
    // a naive search for it flags that as a leak.
    const responses = [...body.matchAll(/res\.json\(([^;]*)\)/g)].map(m => m[1]);
    check("the poll responds with accounts and a status",
      responses.some(r => /accounts/.test(r)), responses);
    check("  and no response carries the access token",
      responses.every(r => !/\btoken\b/.test(r)),
      "that token reaches every account this person has, and nothing on screen needs it");
  }

  // ── "not approved yet" is not a failure ─────────────────────────────
  //
  // This endpoint is RFC 8628, so over the wire it answers with OAuth's codes —
  // `authorization_pending`, `slow_down` — while the AWS API reference lists the
  // SDK's exception class names. Matching only the class names meant the
  // ordinary answer to the first several polls was treated as an error: the
  // loop stopped and the screen waited for ever for something that had already
  // given up.
  //
  // Invisible until somebody actually signs in, which is why it is pinned here.
  {
    const realFetch = globalThis.fetch;
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    const pollWith = async (status: number, body: unknown) => {
      globalThis.fetch = (async () => reply(status, body)) as any;
      try {
        return { token: await pollForToken({
          clientId: "c", clientSecret: "s", deviceCode: "d", ssoRegion: "us-east-1",
        }), error: null as any };
      } catch (e: any) {
        return { token: undefined, error: e };
      } finally {
        globalThis.fetch = realFetch;
      }
    };

    for (const code of ["authorization_pending", "AuthorizationPendingException"]) {
      const r = await pollWith(400, { error: code });
      check(`"${code}" means keep waiting, not fail`, r.token === null && !r.error, r.error?.message);
    }
    for (const code of ["slow_down", "SlowDownException"]) {
      const r = await pollWith(400, { error: code });
      check(`"${code}" means keep waiting too`, r.token === null && !r.error, r.error?.message);
    }

    const expired = await pollWith(400, { error: "expired_token" });
    check("an expired request fails, and says so in words",
      !!expired.error && /expired/i.test(expired.error.message), expired.error?.message);

    const denied = await pollWith(400, { error: "access_denied", error_description: "User cancelled" });
    check("a refusal fails rather than waiting for ever",
      !!denied.error, denied.error?.message);

    const ok = await pollWith(200, { accessToken: "tok-123" });
    check("an approval returns the token", ok.token === "tok-123", ok.token);
  }

  // ── the poll loop cannot hang on a failure ──────────────────────────
  {
    const page = fs.readFileSync(`${__dirname}/../frontend/src/pages/LoginPage.tsx`, "utf8");
    check("the polling loop catches its own failures",
      /void poll\(\)\.catch\(/.test(page),
      "an unhandled rejection here leaves the screen waiting with nothing to act on");
    check("  and puts the person back where they can retry",
      /setNewStep\("form"\)/.test(page.slice(page.indexOf("void poll().catch("))));
  }

  // ── signing in uses the profile that was just made ──────────────────
  //
  // `loadProfiles` deliberately keeps whatever was already selected, so a
  // refresh does not yank somebody off their choice. That is right for a
  // refresh and wrong straight after creating a profile: the button said "sign
  // in with work" and signed in with the previous profile, or with none, and
  // AWS answered with a portal error naming nothing about the cause.
  {
    const page = fs.readFileSync(`${__dirname}/../frontend/src/pages/LoginPage.tsx`, "utf8");

    check("the sign-in handler takes a profile rather than only reading state",
      /handleAwsSsoLogin = async \(profile\?: string\)/.test(page));
    check("  and the button after creating one names it explicitly",
      /handleAwsSsoLogin\(created\)/.test(page),
      "the selection has deliberately not moved at that moment");
    check("  keeping the previous selection is still what a refresh does",
      /setSelectedProfile\(prev =>/.test(page));

    // A sign-in that could not start has to say so. Discarding the response
    // produced a button that did nothing, with the reason unread.
    const api = fs.readFileSync(`${__dirname}/../frontend/src/api/auth.ts`, "utf8");
    const fn = api.slice(api.indexOf("export async function triggerAwsSsoLogin"));
    check("a failed sign-in throws rather than being discarded",
      /if \(!res\.ok\)/.test(fn.slice(0, fn.indexOf("\n}"))));
    check("  the handler catches it and clears the half-started state",
      /setAwsSsoStarted\(false\);\s*\n\s*setNewError/.test(page),
      "leaving it set shows reopen/verify for a sign-in that never began");
    check("  and the message is visible from any tab, not only the one it came from",
      /newError && awsMethod !== "new"/.test(page));

    // Handing a handler that takes an argument straight to onClick.
    //
    // React calls it with the click event, so `handleAwsSsoLogin` received a
    // synthetic event as its `profile` and stored the object in state. Nothing
    // failed at that point; it failed one line later when the button rendered
    // `Sign in as {selectedProfile}` and React was asked to render an object —
    // a blank screen and a minified error, on every click, for every profile.
    //
    // The compiler could not see it: Button declared `onClick?: () => void`, and
    // a handler whose only parameter is optional is assignable to that. So the
    // guard is here, and the prop now names the event it really receives.
    for (const m of page.matchAll(/onClick=\{(\w+)\}/g)) {
      const handler = m[1];
      const decl = new RegExp(`const ${handler} = async \\(([^)]*)\\)`).exec(page);
      check(`  ${handler} takes no argument, so onClick may pass it the event`,
        !decl || decl[1].trim() === "",
        "React passes the click event to any handler wired bare to onClick");
    }
    check("  the click event cannot reach the profile name even if one is",
      /typeof profile === "string"/.test(page));

    const design = fs.readFileSync(`${__dirname}/../frontend/src/design/index.tsx`, "utf8");
    check("  and Button's onClick is typed with the event it really gets",
      /onClick\?: \(event: React\.MouseEvent/.test(design),
      "declaring it `() => void` hid the mismatch from the compiler");
  }

  // ── a profile written now has to be usable now ──────────────────────
  //
  // The SDK parses ~/.aws/config once per process and caches it forever; there
  // is no invalidation because a config file is not normally expected to change
  // under a running program. This app changes it. Until it was refreshed, a
  // profile created here was written correctly, signed into successfully by the
  // AWS CLI, and invisible to the app that had just made it — "Verify does
  // nothing, but it works after I restart", which was this cache being dropped.
  //
  // Exercised against the real SDK rather than by reading source, because the
  // thing that would break it is the SDK changing, not this file changing. It
  // has already moved once, out of `@smithy/shared-ini-file-loader`.
  {
    const tmp = `${os.tmpdir()}/repro-ssosetup-${process.pid}.config`;
    const previous = process.env.AWS_CONFIG_FILE;
    process.env.AWS_CONFIG_FILE = tmp;
    try {
      fs.writeFileSync(tmp, "[profile existing]\nregion = us-east-1\n");
      const { loadSharedConfigFiles } = await import("@smithy/core/config");

      const before = await loadSharedConfigFiles();
      check("a profile present at startup is visible",
        Object.keys(before.configFile).includes("existing"));

      fs.appendFileSync(tmp, "\n[profile freshly-made]\nregion = us-east-1\n");

      const stale = await loadSharedConfigFiles();
      check("  a profile written afterwards is NOT visible on its own",
        !Object.keys(stale.configFile).includes("freshly-made"),
        "if this fails the SDK stopped caching and the refresh is now redundant");

      const refreshed = await refreshAwsConfigCache();
      check("  refreshing the cache reports success", refreshed === true);

      const after = await loadSharedConfigFiles();
      check("  and then the new profile is visible",
        Object.keys(after.configFile).includes("freshly-made"),
        "this is the whole fix: usable without restarting");
      check("  without dropping the profiles already there",
        Object.keys(after.configFile).includes("existing"));
    } finally {
      if (previous === undefined) delete process.env.AWS_CONFIG_FILE;
      else process.env.AWS_CONFIG_FILE = previous;
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    }

    // And that it is actually called where the file changes.
    const routes = fs.readFileSync(`${__dirname}/src/routes/auth.ts`, "utf8");
    check("  the create-profile route refreshes after writing",
      /refreshAwsConfigCache[\s\S]{0,120}res\.json\(\{ profile: profileName/.test(routes));
    check("  and switching profiles refreshes too, for edits made in a terminal",
      (routes.match(/refreshAwsConfigCache\(\)/g) ?? []).length >= 3);

    // A Verify that failed used to be indistinguishable from one that worked.
    const page = fs.readFileSync(`${__dirname}/../frontend/src/pages/LoginPage.tsx`, "utf8");
    check("  a Verify that cannot reach AWS says so rather than doing nothing",
      /if \(!result\.reachable\)/.test(page));
    const verify = page.slice(page.indexOf("const handleReconnectAws"));
    const body = verify.slice(0, verify.indexOf("\n  };"));
    check("  and only a reachable one stops offering to reopen the browser",
      body.indexOf("setAwsSsoStarted(false)") > body.indexOf("!result.reachable"),
      "clearing it unconditionally hides the browser button after a failed check");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
