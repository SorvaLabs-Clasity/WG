import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { parseExportBlock } from "../lib/awsCredentialBlock";
import { useNavigate } from "react-router-dom";
import {
  getLoginUrl,
  fetchAuthStatus,
  invalidateAws,
  reconnectAws,
  triggerAwsSsoLogin,
  revokeGithub,
  fetchAwsProfiles,
  startSsoSetup,
  pollSsoSetup,
  createSsoProfile,
  type SsoAccount,
  type SsoDeviceAuth,
  useAwsProfile,
  setAwsAccessKeys,
  verifyStoredToken,
  type AuthStatus,
  type AwsProfile,
} from "../api/auth";
import { clearToken, isAuthenticated, getUserInfo, getToken } from "../api/client";
import { useTheme } from "../hooks/useTheme";
import { INTENT, TYPE, SURFACE, EASE, enter, COMPANY_NAME, type Intent, Button, Segmented, Spinner } from "../design";

/**
 * Sign-in.
 *
 * Two credentials, and the second cannot be turned until the first is: the
 * GitHub OAuth keys live in the AWS account this app is pointed at. Any
 * arrangement that draws them as equal siblings is lying about that, and the
 * question people arrive with is not which two things there are, it is which
 * one is their turn.
 *
 * So the window is two rooms. The one that wants something from you is the
 * wide lit surface; the one that cannot open yet is left as bare page ground
 * with a seam, so the dependency is a material fact rather than a caption. The
 * split moves as you make progress, which makes the geometry the status.
 *
 * The way out runs under both rooms and turns the app's own green the moment it
 * works, because this is a screen whose entire purpose is to be left.
 */

type Stage = "loading" | "offline" | "aws" | "github" | "ready";

export default function LoginPage() {
  const navigate = useNavigate();
  const loginUrl = getLoginUrl();
  const { theme, toggle } = useTheme();

  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState<"aws" | "github" | null>(null);
  const [awsSsoStarted, setAwsSsoStarted] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  /** Which build this is. Empty in a browser, where there is no build. */
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    window.electronAPI?.getAppVersion?.()
      .then(setAppVersion)
      .catch(() => { /* a missing version must not break signing in */ });
  }, []);

  const [awsProfiles, setAwsProfiles] = useState<AwsProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [awsMethod, setAwsMethod] = useState<"sso" | "profile" | "keys" | "new">("sso");

  /**
   * Creating an SSO profile from here, rather than in a terminal.
   *
   * `aws configure sso` already does this and is a terminal wizard. Somebody
   * handed this app to look after GitHub settings is not necessarily somebody
   * who edits ~/.aws/config, and one wrong line there fails with an error
   * naming none of what is wrong.
   *
   * Four states, because the middle one is a person in their browser:
   *   form    → collecting the sign-in URL
   *   waiting → they are approving it; we poll
   *   choose  → AWS told us what they can reach; they pick
   *   done    → written
   */
  const [newStep, setNewStep] = useState<"form" | "waiting" | "choose" | "done">("form");
  const [newStartUrl, setNewStartUrl] = useState("");
  const [newSsoRegion, setNewSsoRegion] = useState("us-east-2");
  /**
   * Where this app's own infrastructure is, and so which install this profile
   * opens.
   *
   * Seeded from `VITE_AWS_REGION`, which the setup script writes for the
   * install a build was made for, and always editable. Hidden whenever that is
   * set, the one field that picks between regions is the one the build answers
   * on your behalf, and no profile can be made for another region.
   */
  const [newRegion, setNewRegion] = useState(
    (import.meta.env.VITE_AWS_REGION as string | undefined) || "");
  const [newProfileName, setNewProfileName] = useState("");
  const [newAccounts, setNewAccounts] = useState<SsoAccount[]>([]);
  const [newAccountId, setNewAccountId] = useState("");
  const [newRoleName, setNewRoleName] = useState("");
  const [newAuth, setNewAuth] = useState<SsoDeviceAuth | null>(null);
  const [newError, setNewError] = useState("");
  /** Adding a profile while already connected, without disconnecting first. */
  const [addingProfile, setAddingProfile] = useState(false);
  const [newBusy, setNewBusy] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const touchedMethod = useRef(false);
  const [akPasteMode, setAkPasteMode] = useState(true);
  const [akPasteBlock, setAkPasteBlock] = useState("");
  const [akId, setAkId] = useState("");
  const [akSecret, setAkSecret] = useState("");
  const [akSession, setAkSession] = useState("");
  const [akRegion, setAkRegion] = useState("");

  const [ghAuthed, setGhAuthed] = useState(isAuthenticated());
  const [userInfo, setLocalUserInfo] = useState(getUserInfo());
  const [justSignedOut, setJustSignedOut] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);

  /**
   * The account this machine last signed in with. Survives quitting the app,
   * the token lives in sessionStorage and goes, the identity is kept, but is
   * cleared by an explicit sign-out, which is the difference between "you were
   * here a moment ago" and "you deliberately left".
   */
  const remembered = !ghAuthed && !justSignedOut && userInfo?.login ? userInfo : null;

  /** Only the desktop app can drop GitHub's cookies; a web page cannot. */
  const canSwitchAccount = typeof (window as any).electronAPI?.clearGithubSession === "function";

  const handleUseDifferentAccount = async () => {
    setSwitchingAccount(true);
    try {
      // Must finish before navigating: the main process uses this to decide to
      // open the next OAuth attempt in a cookie-free window, and a navigation
      // that beats the IPC lands straight back on the same account.
      await (window as any).electronAPI.clearGithubSession();
    } catch { /* fall through. The worst case is the usual instant sign-in */ }
    clearToken();
    setLocalUserInfo(null);
    window.location.href = loginUrl;
  };

  const authError = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const kind = params.get("auth_error");
    if (!kind) return null;
    const result = {
      kind,
      login: params.get("login") || "unknown",
      org: params.get("org") || "the organization",
      detail: params.get("detail") || "",
    };
    window.history.replaceState({}, "", window.location.pathname);
    return result;
  }, []);

  const [authErrorDismissed, setAuthErrorDismissed] = useState(false);

  const awsOk = !!(status?.aws.connected && status.aws.dynamoReachable);
  const ghConfigured = status?.github.configured;
  const canEnter = awsOk && ghAuthed;

  const checkStatus = useCallback(async () => {
    try {
      const s = await fetchAuthStatus();
      setStatus(s);
      setError(false);
    } catch {
      setError(true);
    }
    setLoading(false);
    setRefreshing(null);
  }, []);

  /**
   * Read the profiles from ~/.aws/config.
   *
   * `pickMethod` only on the first load: once someone has chosen a tab, a
   * refresh must not move them off it.
   */
  const loadProfiles = useCallback(async (pickMethod: boolean, preferred?: string) => {
    try {
      const list = await fetchAwsProfiles();
      setAwsProfiles(list);
      setProfilesError(null);
      // The profile you last signed in with, then whatever happens to be first
      // in ~/.aws/config. Falling straight to the first one is why this asked
      // every launch: the preselected answer was almost never the right one.
      setSelectedProfile(prev =>
        prev || (preferred && list.some(pr => pr.name === preferred) ? preferred : "") || list[0]?.name || "");
      if (pickMethod) {
        const hasSso = list.some(pr => pr.type === "sso");
        if (!hasSso) setAwsMethod(list.length > 0 ? "profile" : "keys");
        // And put them on the tab that profile belongs to, so a remembered SSO
        // profile does not land on the access-key form.
        const remembered = list.find(pr => pr.name === preferred);
        if (remembered) setAwsMethod(remembered.type === "sso" ? "sso" : "profile");
      }
    } catch (err) {
      setAwsProfiles([]);
      setProfilesError((err as Error).message);
      if (pickMethod) setAwsMethod("keys");
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const token = getToken();
    if (token) {
      verifyStoredToken(token).then((result) => {
        if (!result.valid) {
          clearToken();
          setGhAuthed(false);
          setLocalUserInfo(null);
        }
      });
    }
  }, [checkStatus]);

  /**
   * Keep asking until GitHub OAuth reports itself configured.
   *
   * The backend loads its OAuth secrets from Secrets Manager asynchronously,
   * after it has already started listening, so for the first half-second or so
   * of every launch, /auth/status honestly answers "not configured". The window
   * opens inside that gap often enough that reading status once at mount is a
   * coin flip, and losing it left the page permanently claiming OAuth was
   * missing from the build until someone thought to restart.
   *
   * Capped rather than endless: a build that genuinely has no OAuth secrets
   * should say so, not poll for the rest of the session.
   */
  const [settling, setSettling] = useState(true);
  useEffect(() => {
    if (ghConfigured) { setSettling(false); return; }
    if (loading || error) return;
    // Nothing to wait for until AWS is up: the secrets come from Secrets
    // Manager, so polling before that just burns the timeout and lands on the
    // wrong message.
    if (!awsOk) return;

    let tries = 0;
    const id = setInterval(() => {
      if (++tries > 20) {          // ~20 seconds, then believe the answer
        setSettling(false);
        clearInterval(id);
        return;
      }
      checkStatus();
    }, 1000);
    return () => clearInterval(id);
  }, [ghConfigured, loading, error, awsOk, checkStatus]);

  // Re-read whenever AWS is not connected, on first load, and again the moment
  // Disconnect is pressed. The list was previously fetched once at mount, so a
  // disconnect showed whatever had been cached, and only relaunching the app
  // brought the SSO profiles back.
  useEffect(() => {
    if (awsOk) return;
    // status.aws.profile is the profile the backend restored from the last
    // successful sign-in, so it is the one to preselect.
    loadProfiles(!touchedMethod.current, status?.aws.profile);
  }, [awsOk, loadProfiles, status?.aws.profile]);

  const stage: Stage =
    loading ? "loading"
    : error ? "offline"
    : canEnter ? "ready"
    : awsOk ? "github"
    : "aws";

  const connected = (awsOk ? 1 : 0) + (ghAuthed ? 1 : 0);

  /* ── AWS handlers ── */
  const handleDisconnectAws = async () => {
    setRefreshing("aws");
    setAwsSsoStarted(false);
    await invalidateAws();
    await checkStatus();
  };

  /**
   * Start `aws sso login` for a profile.
   *
   * Takes the profile rather than reading `selectedProfile`, because the caller
   * sometimes knows better than the state does. Straight after creating a
   * profile the selection has deliberately not moved, `loadProfiles` keeps
   * whatever was chosen before, so a refresh does not yank people off their
   * choice, so a button saying "sign in with work" was signing in with the
   * previous profile, or with none, and AWS answered with a portal error naming
   * nothing.
   */
  const handleAwsSsoLogin = async (profile?: string) => {
    // Only a string is a profile name. Wired straight to a button's onClick this
    // would otherwise be handed a click event, and `setSelectedProfile(event)`
    // puts an object where a name belongs, which does not fail here, it fails
    // later when something renders it, as a blank screen with a minified error.
    const named = typeof profile === "string" ? profile : undefined;
    const target = named || selectedProfile || undefined;
    if (target) setSelectedProfile(target);
    setNewError("");
    setAwsSsoStarted(true);
    try {
      await triggerAwsSsoLogin(target);
    } catch (e: any) {
      // Back to a state somebody can act from. Leaving `awsSsoStarted` set
      // shows "reopen browser / verify" for a sign-in that never began, which
      // is the shape of a button that does nothing.
      setAwsSsoStarted(false);
      setNewError(e?.message || "Could not start the AWS sign-in.");
    }
  };

  /**
   * "Verify", I have signed in over there, look again.
   *
   * The backend answers `reachable: false` with the reason when it still cannot
   * reach DynamoDB. Discarding that turns every failure into a button that
   * visibly does nothing: not signed in yet, wrong account, no network, all
   * identical on screen.
   */
  const handleReconnectAws = async () => {
    setRefreshing("aws");
    setNewError("");
    try {
      const result = await reconnectAws(selectedProfile || undefined);
      if (!result.reachable) {
        setNewError(result.error
          ? `Signed in, but AWS is still not reachable: ${result.error}`
          : "AWS is still not reachable. Finish the sign-in in your browser, then hit Verify again.");
      } else {
        // Only on success: leaving it set keeps offering "reopen browser" for a
        // sign-in that is already done.
        setAwsSsoStarted(false);
      }
    } catch (e: any) {
      setNewError(e?.message || "Could not check the AWS sign-in.");
    }
    await checkStatus();
  };

  /**
   * Start the sign-in, open the browser, and poll until they approve.
   *
   * Polling at the interval AWS asks for, and stopping when it says the code has
   * expired, a loop that keeps asking after that is asking about something that
   * no longer exists.
   */
  const handleNewSsoStart = async () => {
    setNewError(""); setNewBusy(true);
    try {
      const auth = await startSsoSetup(newStartUrl.trim(), newSsoRegion.trim());
      setNewAuth(auth);
      setNewStep("waiting");
      // Opened for them. The URL carries the code, so there is nothing to type.
      window.open(auth.verificationUriComplete, "_blank");

      const poll = async (): Promise<void> => {
        if (Date.now() > auth.expiresAt) {
          setNewError("That sign-in request expired. Start again.");
          setNewStep("form"); setNewBusy(false);
          return;
        }
        const result = await pollSsoSetup({
          clientId: auth.clientId, clientSecret: auth.clientSecret,
          deviceCode: auth.deviceCode, ssoRegion: newSsoRegion.trim(),
        });
        if (result.status === "pending") {
          setTimeout(poll, auth.interval * 1000);
          return;
        }
        setNewAccounts(result.accounts);
        if (result.accounts.length === 1) {
          setNewAccountId(result.accounts[0].accountId);
          if (result.accounts[0].roles.length === 1) setNewRoleName(result.accounts[0].roles[0]);
        }
        setNewStep("choose"); setNewBusy(false);
      };
      // Caught, because this is fire-and-forget.
      //
      // Without it, any failure inside the loop became an unhandled rejection:
      // the recursion stopped, nothing was set, and the screen sat on "approve
      // it in your browser" for ever, the one outcome that tells the person
      // nothing at all. A hang is worse than an error, because there is nothing
      // to act on and no reason to stop waiting.
      void poll().catch((e: any) => {
        setNewError(e?.message || "The sign-in could not be completed.");
        setNewStep("form");
        setNewBusy(false);
      });
    } catch (e: any) {
      setNewError(e?.message || "Could not start the AWS sign-in");
      setNewStep("form"); setNewBusy(false);
    }
  };

  const handleNewSsoCreate = async () => {
    setNewError(""); setNewBusy(true);
    try {
      await createSsoProfile({
        profileName: newProfileName.trim(),
        startUrl: newStartUrl.trim(),
        ssoRegion: newSsoRegion.trim(),
        accountId: newAccountId,
        roleName: newRoleName,
        region: newRegion.trim(),
      });
      setNewStep("done");
      // The new profile has to appear in the picker, or the obvious next step
      // is to use something that looks like it does not exist yet.
      await loadProfiles(false, newProfileName.trim());
    } catch (e: any) {
      setNewError(e?.message || "Could not create the profile");
    } finally {
      setNewBusy(false);
    }
  };

  const handleUseProfile = async () => {
    if (!selectedProfile) return;
    setNewError("");
    setRefreshing("aws");
    // The same reporting the account switcher already does. Discarding this
    // made "Use <profile>" silent for the ordinary case of an SSO profile whose
    // session has expired, the switch did nothing and said nothing.
    const result = await useAwsProfile(selectedProfile);
    if (!result.reachable) {
      setNewError(result.error
        ? `Could not use ${selectedProfile}: ${result.error}`
        : `Could not reach AWS with ${selectedProfile}. It may need signing in again.`);
    }
    await checkStatus();
  };


  const handlePasteBlockConnect = async () => {
    const parsed = parseExportBlock(akPasteBlock);
    const id = parsed.AWS_ACCESS_KEY_ID;
    const secret = parsed.AWS_SECRET_ACCESS_KEY;
    // Saying which part is missing, rather than returning and leaving a button
    // that looks broken. This is the most likely thing to go wrong here.
    if (!id || !secret) {
      setNewError(Object.keys(parsed).length === 0
        ? "Could not find any credentials in that. Paste the whole block from the "
          + "AWS access portal. Any of its formats will do."
        : `That block is missing ${!id ? "AWS_ACCESS_KEY_ID" : "AWS_SECRET_ACCESS_KEY"}.`);
      return;
    }
    setNewError("");
    setRefreshing("aws");
    const result = await setAwsAccessKeys({
      accessKeyId: id,
      secretAccessKey: secret,
      sessionToken: parsed.AWS_SESSION_TOKEN || undefined,
      region: parsed.AWS_DEFAULT_REGION || parsed.AWS_REGION || undefined,
    });
    if (!result.reachable) {
      setNewError(result.error
        ? `Those keys did not work: ${result.error}`
        : "Those keys did not reach AWS. They may have expired.");
    }
    await checkStatus();
  };

  const pasteBlockValid = useMemo(() => {
    const parsed = parseExportBlock(akPasteBlock);
    return !!(parsed.AWS_ACCESS_KEY_ID && parsed.AWS_SECRET_ACCESS_KEY);
  }, [akPasteBlock]);

  const handleAccessKeys = async () => {
    if (!akId || !akSecret) return;
    setNewError("");
    setRefreshing("aws");
    const result = await setAwsAccessKeys({
      accessKeyId: akId,
      secretAccessKey: akSecret,
      sessionToken: akSession || undefined,
      region: akRegion || undefined,
    });
    // Same silence as the paste block had: expired keys looked like a dead button.
    if (!result.reachable) {
      setNewError(result.error
        ? `Those keys did not work: ${result.error}`
        : "Those keys did not reach AWS. They may have expired.");
    }
    await checkStatus();
  };

  /* ── GitHub handlers ── */
  const handleSignOutGithub = async () => {
    setSigningOut(true);
    const token = getToken();
    if (token) {
      try { await revokeGithub(token); } catch {}
    }
    clearToken();
    if ((window as any).electronAPI?.clearGithubSession) {
      try { await (window as any).electronAPI.clearGithubSession(); } catch {}
    }
    setGhAuthed(false);
    setLocalUserInfo(null);
    setSigningOut(false);
    setJustSignedOut(true);
  };

  const handleDisconnectAll = async () => {
    setRefreshing("aws");
    const token = getToken();
    if (token) {
      try { await revokeGithub(token); } catch {}
    }
    clearToken();
    if ((window as any).electronAPI?.clearGithubSession) {
      try { await (window as any).electronAPI.clearGithubSession(); } catch {}
    }
    setGhAuthed(false);
    setLocalUserInfo(null);
    await invalidateAws();
    await checkStatus();
  };

  const awsBusy = loading || refreshing === "aws";

  return (
    <div className={`min-h-screen flex flex-col ${SURFACE.page} text-slate-900 dark:text-slate-100`}>

      {/* Chrome at the height the signed-in navbar uses, so arriving at the
          dashboard is the same window continuing rather than a different one
          replacing it. */}
      {/* The masthead, at the height the signed-in one uses, so arriving at the
          dashboard is the same paper continuing rather than a different one
          replacing it. */}
      <header className="sticky top-0 z-30 shrink-0 bg-paper border-b-2 border-ink">
        <div className="px-5 sm:px-8 py-3.5 flex items-end justify-between gap-5 flex-wrap">
          <div className="min-w-0">
            <h1 className="display text-[1.6rem] sm:text-[1.9rem] leading-none text-ink">
              GitHub Control Hub
            </h1>
            {/* Said before anything is typed, because the next thing this screen
                asks for is a set of AWS keys and the reasonable worry is where
                they are about to go. The build is here too, not only in the
                account menu: the menu needs somebody signed in, and the moment
                you most want to know which build you are running is the moment
                the app is not working. Which is this screen. */}
            <div className="dateline mt-2 text-[12px]">
              <span className="caps">{COMPANY_NAME}</span>
              <span>Running locally on this machine</span>
              {appVersion && <span className="font-mono">v{appVersion}</span>}
            </div>
          </div>

          <button onClick={toggle} className="textlink caps shrink-0"
            title={theme === "dark" ? "Switch to the day edition" : "Switch to the night edition"}>
            {theme === "dark" ? "Day edition" : "Night edition"}
          </button>
        </div>
      </header>

      {/* Above both rooms rather than inside one. A dead backend makes both
          panels unknowable, and a wrong-account error arrives while the GitHub
          panel may still be sealed and recessed, which is exactly where nobody
          would read it. */}
      {((authError && !authErrorDismissed) || error) && (
        <div className="shrink-0 px-5 pt-4 space-y-3">
          {authError && !authErrorDismissed && (
            <Banner
              intent="danger"
              icon="ph-fill ph-warning-circle"
              title={authError.kind === "not_member" ? "Wrong GitHub account" : "Authentication failed"}
              onDismiss={() => setAuthErrorDismissed(true)}
              index={0}
            >
              {authError.kind === "not_member" ? (
                <>Signed in as <span className="font-mono font-bold">@{authError.login}</span>, which is not a
                member of <span className="font-bold">{authError.org}</span>. Sign in with an account that is.</>
              ) : (
                authError.detail || "Something went wrong during authentication."
              )}
            </Banner>
          )}

          {error && (
            <Banner intent="danger" icon="ph-fill ph-plugs" title="Backend unreachable" index={0}>
              Nothing is responding on the local API. Make sure{" "}
              <code className="font-mono text-[12.5px] px-1.5 py-0.5 rounded bg-rose-500/15">ghch serve</code>{" "}
              is running, then reload.
            </Banner>
          )}
        </div>
      )}

      <main
        className={`flex-1 grid grid-cols-1 ${splitFor(stage, addingProfile)} transition-[grid-template-columns] duration-700`}
        style={{ transitionTimingFunction: EASE }}
      >
        {/* ── AWS ── */}
        <Panel
          index={1}
          intent={awsOk ? "good" : error ? "danger" : "neutral"}
          icon="ph-fill ph-cloud"
          busy={awsBusy}
          service="Amazon Web Services"
          title={loading ? "Checking" : awsOk ? "Connected" : error ? "Offline" : "Not connected"}
          subtitle={
            awsOk && status?.aws.profile
              ? <>Profile <span className="font-mono font-bold text-emerald-700 dark:text-emerald-300">{status.aws.profile}</span></>
              : awsOk ? "DynamoDB and Secrets Manager reachable"
              : "Needed to read and write the app's own data"
          }
          actions={awsOk && !loading && !error
            ? <>
                {/* Reachable while connected, because "add a profile for the
                    other account" is exactly when somebody wants it, and
                    before this, the only way to reach it was to disconnect
                    from the account they were happily using. */}
                <Quiet onClick={() => { setAwsMethod("new"); setNewStep("form"); setAddingProfile(true); }}
                  icon="ph-bold ph-plus" label="Add profile" />
                <Quiet onClick={handleDisconnectAws} disabled={refreshing === "aws"} icon="ph-bold ph-plugs" label="Disconnect" />
              </>
            : undefined}
        >
          {!loading && !error && awsOk && addingProfile && (
            <div className={`mb-4 flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 ${SURFACE.inset}`}>
              <span className="text-xs text-slate-600 dark:text-slate-300">
                Adding a profile. You stay signed in to <strong>{status?.aws.profile || "this account"}</strong>.
              </span>
              <button onClick={() => setAddingProfile(false)}
                className="shrink-0 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-ink">
                Cancel
              </button>
            </div>
          )}

          {!loading && !error && (!awsOk || addingProfile) && (
            <div className="space-y-3.5">
              {profilesError && (
                <Hint intent="warn">
                  Could not read your AWS profiles: {profilesError}. Access keys still work.
                </Hint>
              )}
              {/* Shown above the tabs rather than inside one, because a
                  sign-in can be started from more than one of them and an
                  error rendered in the panel you have since left is an error
                  nobody sees. */}
              {newError && awsMethod !== "new" && (
                <Hint intent="danger">{newError}</Hint>
              )}
              {!addingProfile && <Segmented
                value={awsMethod}
                onChange={(v) => { touchedMethod.current = true; setAwsMethod(v); setAwsSsoStarted(false); }}
                options={([
                  ["sso", "SSO"] as [typeof awsMethod, string],
                  ["keys", "Access keys"] as [typeof awsMethod, string],
                  ["profile", "Profile"] as [typeof awsMethod, string],
                  ["new", "New profile"] as [typeof awsMethod, string],
                ]).filter(([id]) =>
                  // Access keys always work. SSO and Profile need a profile to
                  // exist already, and "New profile" is the way out of having
                  // none, so it is the one option that must never be hidden.
                  // SSO stays whether or not one exists yet: hiding it meant a
                  // machine with no SSO profile showed nothing mentioning SSO
                  // at all, and the way to make one was a tab called "New
                  // profile", so the people who most needed it were the only
                  // ones who could not find it. Empty, the tab explains itself.
                  id === "keys" || id === "new" || id === "sso" ||
                  (id === "profile" && awsProfiles.length > 0)
                )}
              />}

              {awsMethod === "sso" && awsProfiles.every(p => p.type !== "sso") && (
                <div className="space-y-2.5">
                  <Hint intent="info">
                    No SSO profiles on this machine yet. Creating one asks AWS which
                    accounts and roles you have, so you pick from a list instead of
                    hunting for an account number.
                  </Hint>
                  <div className="flex justify-end">
                    <Button variant="primary"
                      onClick={() => { setAwsMethod("new"); setNewStep("form"); }}
                      className="w-full sm:w-auto">
                      <i className="ph-bold ph-plus mr-2"></i>Create an SSO profile
                    </Button>
                  </div>
                </div>
              )}

              {awsMethod === "sso" && awsProfiles.some(p => p.type === "sso") && (
                <div className="space-y-2.5">
                  {awsProfiles.filter(p => p.type === "sso").length > 1 && !awsSsoStarted && (
                    <select value={selectedProfile} onChange={e => setSelectedProfile(e.target.value)} className={SURFACE.input}>
                      {awsProfiles.filter(p => p.type === "sso").map(p => (
                        <option key={p.name} value={p.name}>
                          {p.name}{p.accountId ? ` (${p.accountId})` : ""}{p.roleName ? `, ${p.roleName}` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {awsSsoStarted && (
                    <Hint intent="info">
                      A browser tab opened for AWS SSO. Finish signing in there, then come back and hit Verify.
                    </Hint>
                  )}
                  <div className="flex justify-end gap-2">
                    {!awsSsoStarted ? (
                      <Button variant="primary" onClick={() => handleAwsSsoLogin()} className="w-full sm:w-auto">
                        <i className="ph-bold ph-browser mr-2"></i>
                        Sign in as {selectedProfile || "default"}
                      </Button>
                    ) : (
                      <>
                        <Button variant="ghost" onClick={() => handleAwsSsoLogin()}>Reopen browser</Button>
                        <Button variant="primary" onClick={handleReconnectAws} disabled={refreshing === "aws"}>
                          <i className="ph-bold ph-arrow-clockwise mr-2"></i>Verify
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {awsMethod === "profile" && (
                <div className="space-y-2.5">
                  <select value={selectedProfile} onChange={e => setSelectedProfile(e.target.value)} className={SURFACE.input}>
                    {awsProfiles.map(p => (
                      <option key={p.name} value={p.name}>
                        {p.name} ({p.type}){p.accountId ? `, ${p.accountId}` : ""}{p.roleName ? ` / ${p.roleName}` : ""}
                      </option>
                    ))}
                  </select>
                  <div className="flex justify-end">
                    <Button variant="primary" onClick={handleUseProfile} disabled={refreshing === "aws" || !selectedProfile}>
                      <i className="ph-bold ph-user-switch mr-2"></i>Use {selectedProfile || "profile"}
                    </Button>
                  </div>
                </div>
              )}

              {awsMethod === "new" && (
                <div className="space-y-3">
                  {newError && (
                    <Hint intent="danger">{newError}</Hint>
                  )}

                  {newStep === "form" && (
                    <>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Creates an AWS profile on this computer, so you do not have to
                        edit files or use a terminal. You need the sign-in link. It
                        usually ends in <code>.awsapps.com/start</code>.
                      </p>
                      <Field label="AWS sign-in link">
                        <input value={newStartUrl} onChange={e => setNewStartUrl(e.target.value)}
                          placeholder="https://your-company.awsapps.com/start"
                          className={SURFACE.input} />
                      </Field>
                      <Field label="Region of that sign-in link">
                        <input value={newSsoRegion} onChange={e => setNewSsoRegion(e.target.value)}
                          placeholder="us-east-2" className={SURFACE.input} />
                        <Aside>
                          Where your company's AWS login lives, one region for the whole
                          company.
                        </Aside>
                      </Field>

                      {/* Always asked, and pre-filled when the build knows one.
                          It used to be hidden whenever `VITE_AWS_REGION` was
                          baked in, on the reasoning that the app already knew
                          the answer. That held while there was one install.
                          With one per region it made the app unable to create
                          a profile for any region but the one it was built
                          for, and it did not say so: the field was simply not
                          there, and every profile came out pointing at the
                          same region. */}
                      <Field label="Region this app runs in">
                        <input value={newRegion} onChange={e => setNewRegion(e.target.value)}
                          placeholder="us-east-2" className={SURFACE.input} />
                        <Aside>
                          Where this app's tables and secrets are, which is the install this
                          profile opens. Often a different region from the sign-in above.
                          {import.meta.env.VITE_AWS_REGION && (
                            <> This build was made for{" "}
                              <code>{import.meta.env.VITE_AWS_REGION as string}</code>, so that is
                              filled in. Change it to reach another region's install.</>
                          )}
                        </Aside>
                      </Field>
                      <div className="flex justify-end">
                        <Button variant="primary" onClick={handleNewSsoStart}
                          disabled={newBusy || !newStartUrl.trim() || !newSsoRegion.trim() || !newRegion.trim()}>
                          <i className="ph-bold ph-arrow-square-out mr-2"></i>
                          Continue in browser
                        </Button>
                      </div>
                    </>
                  )}

                  {newStep === "waiting" && (
                    <div className="text-center py-2 space-y-2">
                      <Spinner />
                      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                        Approve the sign-in in your browser
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        A tab should have opened. Confirm the code shown there, then come back -
                        this page carries on by itself.
                      </p>
                      {newAuth && (
                        <p className="text-xs text-slate-400">
                          Code: <code className="font-mono">{newAuth.userCode}</code>
                          {" · "}
                          <a href={newAuth.verificationUriComplete} target="_blank" rel="noreferrer"
                            className="underline">open it again</a>
                        </p>
                      )}
                    </div>
                  )}

                  {newStep === "choose" && (
                    <>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Signed in. These are the accounts you can reach, pick the one this
                        app is deployed in.
                      </p>
                      <Field label="Account">
                        <select value={newAccountId} className={SURFACE.input}
                          onChange={e => {
                            setNewAccountId(e.target.value);
                            // The role list belongs to the account, so a stale
                            // one would offer a role that account does not have.
                            const acct = newAccounts.find(a => a.accountId === e.target.value);
                            setNewRoleName(acct?.roles.length === 1 ? acct.roles[0] : "");
                          }}>
                          <option value="">Choose an account…</option>
                          {newAccounts.map(a => (
                            <option key={a.accountId} value={a.accountId}>
                              {a.accountName}: {a.accountId}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Role">
                        <select value={newRoleName} onChange={e => setNewRoleName(e.target.value)}
                          className={SURFACE.input} disabled={!newAccountId}>
                          <option value="">Choose a role…</option>
                          {(newAccounts.find(a => a.accountId === newAccountId)?.roles ?? []).map(r => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Name this profile">
                        <input value={newProfileName} onChange={e => setNewProfileName(e.target.value)}
                          placeholder="work" className={SURFACE.input} />
                        <Aside>
                          Letters, numbers, dots, dashes and underscores. What you will pick
                          from the Profile tab later.
                        </Aside>
                      </Field>
                      <div className="flex justify-end">
                        <Button variant="primary" onClick={handleNewSsoCreate}
                          disabled={newBusy || !newAccountId || !newRoleName || !newProfileName.trim()}>
                          <i className="ph-bold ph-floppy-disk mr-2"></i>
                          {newBusy ? "Saving…" : "Save profile"}
                        </Button>
                      </div>
                    </>
                  )}

                  {newStep === "done" && (
                    <div className="space-y-2.5">
                      <Hint intent="good">
                        Saved <strong>{newProfileName}</strong> to your AWS config.
                      </Hint>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Now sign in with it. This is the same step you will take each time
                        the session expires.
                      </p>
                      <div className="flex justify-end">
                        <Button variant="primary" disabled={refreshing === "aws"}
                          onClick={() => {
                            // Named explicitly. This is the one place where
                            // the profile to use is known for certain and the
                            // selection has not caught up.
                            const created = newProfileName.trim();
                            setAwsMethod("sso");
                            setAddingProfile(false);
                            void handleAwsSsoLogin(created);
                          }}>
                          <i className="ph-bold ph-sign-in mr-2"></i>Sign in with {newProfileName}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {awsMethod === "keys" && (
                <div className="space-y-2.5">
                  <Segmented
                    value={akPasteMode ? "paste" : "manual"}
                    onChange={(v) => setAkPasteMode(v === "paste")}
                    options={[["paste", "Paste block"], ["manual", "One field at a time"]]}
                  />
                  {akPasteMode ? (
                    <>
                      <textarea
                        rows={4}
                        spellCheck={false}
                        placeholder={'export AWS_ACCESS_KEY_ID="AKIA…"\nexport AWS_SECRET_ACCESS_KEY="wJal…"\nexport AWS_SESSION_TOKEN="IQoJ…"'}
                        value={akPasteBlock}
                        onChange={e => setAkPasteBlock(e.target.value)}
                        className={`${SURFACE.input} font-mono text-[12.5px] leading-relaxed resize-none`}
                      />
                      {akPasteBlock && !pasteBlockValid && (
                        <Hint intent="danger">
                          No <span className="font-mono">AWS_ACCESS_KEY_ID</span> and{" "}
                          <span className="font-mono">AWS_SECRET_ACCESS_KEY</span> found in that. Paste the whole
                          export block.
                        </Hint>
                      )}
                      <div className="flex justify-end">
                        <Button variant="primary" onClick={handlePasteBlockConnect} disabled={refreshing === "aws" || !pasteBlockValid}>
                          <i className="ph-bold ph-key mr-2"></i>Connect
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Field label="Access key ID">
                        <input type="text" value={akId} onChange={e => setAkId(e.target.value)}
                          placeholder="AKIA…" className={`${SURFACE.input} font-mono text-[12.5px]`} />
                      </Field>
                      <Field label="Secret access key">
                        <input type="password" value={akSecret} onChange={e => setAkSecret(e.target.value)}
                          placeholder="••••••••" className={`${SURFACE.input} font-mono text-[12.5px]`} />
                      </Field>
                      <Field label="Session token" optional>
                        <input type="password" value={akSession} onChange={e => setAkSession(e.target.value)}
                          placeholder="••••••••" className={`${SURFACE.input} font-mono text-[12.5px]`} />
                      </Field>
                      {/* Optional, but worth naming: a key pair carries no
                          region, so this is the only thing here that can say
                          which one. Left blank the app falls back to the
                          region it was started with, which is right on a
                          machine that sets one and nothing at all on a
                          machine that does not. */}
                      <Field label="Region" optional>
                        <input type="text" value={akRegion} onChange={e => setAkRegion(e.target.value)}
                          placeholder="us-east-2" className={`${SURFACE.input} font-mono text-[12.5px]`} />
                        <Aside>
                          Which region's install to open. Access keys do not carry one, and with
                          one install per region this is what picks between them.
                        </Aside>
                      </Field>
                      <div className="flex justify-end">
                        <Button variant="primary" onClick={handleAccessKeys} disabled={refreshing === "aws" || !akId || !akSecret}>
                          <i className="ph-bold ph-key mr-2"></i>Connect
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </Panel>

        {/* ── GitHub ── */}
        <Panel
          index={2}
          intent={ghAuthed ? "good" : "neutral"}
          icon="ph-fill ph-github-logo"
          avatar={ghAuthed ? userInfo?.avatarUrl : undefined}
          busy={loading || refreshing === "github" || (awsOk && !ghConfigured && settling)}
          sealed={!awsOk && !ghAuthed}
          service="GitHub"
          title={ghAuthed && userInfo ? userInfo.login : !awsOk ? "Locked" : "Not signed in"}
          subtitle={
            ghAuthed
              ? status?.github.org
                ? <>Member of <span className="font-bold">{status.github.org}</span></>
                : "Authenticated"
              /* AWS first, because the OAuth secrets live in Secrets
                 Manager. Until AWS connects, ghConfigured is false for a
                 reason that has nothing to do with the build, and saying
                 "OAuth is not configured on this build" there sends someone
                 looking at their packaging when the answer is on the panel
                 beside it. */
              : !awsOk ? "Unlocks once AWS is connected"
              : !ghConfigured
                ? settling
                  ? "Loading credentials…"
                  /* Name the step that has not been done, rather than the
                     build. An install whose secret was never created is the
                     ordinary state before setup, not a packaging fault, and
                     saying so sends people to the right place. */
                  : status?.github.reason === "secret_missing"
                    ? "No GitHub credentials stored yet. Run scripts/migrate-to-account.sh"
                    : status?.github.reason === "secret_unreadable"
                      ? "The credentials secret exists but could not be read. Check this account's permissions"
                      : status?.github.reason === "secret_incomplete"
                        ? "The credentials secret is missing its OAuth keys"
                        : "OAuth is not configured on this build"
              : "Your own account, the app acts as you, never as someone else"
          }
          actions={!loading && !error && ghAuthed
            ? <Quiet onClick={handleSignOutGithub} disabled={signingOut}
                icon="ph-bold ph-sign-out" label={signingOut ? "Signing out…" : "Sign out"} />
            : undefined}
        >
          {!loading && !error && !ghAuthed && ghConfigured && awsOk && (
            <div className="space-y-3">
              {justSignedOut && <Hint intent="neutral">Signed out. Sign in below to use a different account.</Hint>}

              {remembered ? (
                /* GitHub still holds a session for this account, so signing in
                   completes the moment it is asked, no page, no choice. Say
                   whose account it will be before that happens, rather than
                   announcing it afterwards. */
                <>
                  <a
                    /* Name the account. Without it GitHub signs in as
                       whichever session the browser holds, which is how
                       "Continue with alice" could produce bob. */
                    href={`${loginUrl}?login=${encodeURIComponent(remembered.login)}`}
                    className="group flex items-center gap-4 w-full no-underline border-t-2 border-ink pt-4"
                  >
                    {remembered.avatarUrl
                      ? <img src={remembered.avatarUrl} alt="" className="w-12 h-12 object-cover shrink-0 border border-rule-strong" />
                      : <span className="w-12 h-12 shrink-0 border border-rule-strong flex items-center justify-center">
                          <i className="ph-fill ph-github-logo text-2xl text-ink-2"></i>
                        </span>}
                    <span className="flex-1 min-w-0 text-left">
                      <span className="block caps">Continue with</span>
                      <span className="display block text-[1.5rem] leading-tight text-ink truncate">
                        {remembered.login}
                      </span>
                    </span>
                    <span className="stamp shrink-0 group-hover:bg-transparent group-hover:text-ink">
                      Sign in
                    </span>
                  </a>

                  {canSwitchAccount && (
                    <button
                      onClick={handleUseDifferentAccount}
                      disabled={switchingAccount}
                      className="textlink caps"
                    >
                      {switchingAccount ? "Signing out of GitHub…" : "Use a different account"}
                    </button>
                  )}
                </>
              ) : (
                <a href={loginUrl}
                  className="group flex items-center gap-4 w-full no-underline border-t-2 border-ink pt-4">
                  <i className="ph-fill ph-github-logo text-[2rem] text-ink shrink-0"></i>
                  <span className="display flex-1 text-[1.5rem] leading-tight text-ink">
                    Sign in with GitHub
                  </span>
                  <span className="stamp shrink-0 group-hover:bg-transparent group-hover:text-ink">
                    Continue
                  </span>
                </a>
              )}
            </div>
          )}
        </Panel>
      </main>

      {/* ── The way out ── */}
      {/*
          Full width, under both rooms, and set on the forest ink the moment it
          works. This is a screen whose entire purpose is to be left, so leaving
          is the largest thing on it, and the sentence beside the count says why
          you cannot go yet rather than making anyone infer it from two panels.

          A rule, not a lifted bar. The old version threw a shadow upwards to
          suggest a floating strip, which is a trick from a design language this
          one does not use.
      */}
      <footer className={`sticky bottom-0 z-30 shrink-0 bg-paper border-t-2 transition-colors duration-500 ${
        canEnter ? "border-forest" : "border-ink"}`}>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 sm:px-8 py-4">
          <span className="flex items-baseline gap-3 min-w-0">
            <span className={`figure text-[1.75rem] shrink-0 ${canEnter ? "text-forest" : "text-ink-3"}`}>
              {connected}<span className="text-ink-4">/2</span>
            </span>
            <span className="standfirst text-[13.5px] leading-snug">
              {REMAINING[stage](status?.github.org)}
            </span>
          </span>

          <span className="ml-auto flex items-center gap-6 shrink-0">
            {(awsOk || ghAuthed) && !loading && !error && (
              <button onClick={handleDisconnectAll} disabled={refreshing !== null}
                className="textlink caps hover:!text-crimson">
                Reset both connections
              </button>
            )}

            <button onClick={() => navigate("/analytics")} disabled={!canEnter}
              className={canEnter
                ? "stamp !bg-forest !border-forest !text-reverse hover:!bg-transparent hover:!text-forest"
                : "stamp stamp-hollow"}>
              Open the dashboard
            </button>
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ── The split ───────────────────────────────────────────────────────── */

/**
 * How the window is divided between the two connections.
 *
 * The side that wants something from you is the wide one, so the geometry is
 * the status and there is nothing to read to know whose turn it is.
 *
 * Adding a profile has to override the stage rather than follow it: it happens
 * while AWS is already connected, so by stage alone the tallest form on the
 * screen would open in the narrow half.
 */
function splitFor(stage: Stage, addingProfile: boolean): string {
  if (addingProfile) return "lg:grid-cols-[1.6fr_1fr]";
  if (stage === "github") return "lg:grid-cols-[1fr_1.6fr]";
  if (stage === "ready") return "lg:grid-cols-[1fr_1fr]";
  return "lg:grid-cols-[1.6fr_1fr]";
}

/**
 * Why you cannot leave yet, one sentence per stage.
 *
 * It lives in the bar you leave by rather than in a headline of its own,
 * because it is only ever read as the answer to "so what is stopping me".
 */
const REMAINING: Record<Stage, (org?: string | null) => React.ReactNode> = {
  loading: () => "Checking what is already connected.",
  offline: () => "The local API is not answering, so neither connection can be checked.",
  aws:     () => "AWS first. The app keeps its own state there, and GitHub's credentials with it.",
  /* The organization is named before the sign-in rather than after it. It is
     the one thing that decides what the account you are about to use may do,
     and the moment to find out you are pointed at the wrong one is now. */
  github:  (org) => <>One to go. Every change is made with your account, so{" "}
             {org ? <span className="font-bold">{org}</span> : "GitHub"} decides what you may do.</>,
  ready:   () => "Both connections are live.",
};

/* ── One connection, one room ────────────────────────────────────────── */

/**
 * A full-height half of the window.
 *
 * `sealed` is the whole point of the layout: a panel that cannot be used yet is
 * left as bare page ground with nothing but a seam, so the dependency between
 * the two credentials is something you see rather than something you read.
 *
 * It withholds the surface rather than dimming what is on it. A sealed panel is
 * the one panel that has to explain itself, and blanket opacity takes the
 * contrast off the sentence doing the explaining.
 */
function Panel({ index, intent, icon, avatar, busy, sealed, service, title, subtitle, actions, children }: {
  index: number; intent: Intent; icon: string; avatar?: string;
  busy?: boolean; sealed?: boolean;
  service: string; title: string; subtitle: React.ReactNode;
  actions?: React.ReactNode; children?: React.ReactNode;
}) {
  const tone = INTENT[intent];

  return (
    <section
      style={enter(index)}
      className={`relative min-w-0 flex flex-col border-rule
        border-b last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0
        ${sealed ? "bg-paper-2" : "bg-paper"}`}
    >
      {/* The state rule takes the whole width of the room, so posture is
          something noticed from across the desk rather than something read. */}
      <span aria-hidden="true"
        className={`h-[3px] shrink-0 ${tone.mark} ${sealed ? "opacity-30" : ""} transition-colors duration-500`} />

      <div className="flex-1 px-6 py-8 sm:px-9 sm:py-10">
        <div className="flex items-start gap-5">
          {avatar ? (
            <img src={avatar} alt={title}
              className="w-12 h-12 object-cover shrink-0 border border-rule-strong" />
          ) : (
            <span className={`w-12 h-12 flex items-center justify-center shrink-0 border ${
              sealed ? "border-rule text-ink-4" : `${tone.border} ${tone.text}`}`}>
              <i className={(busy ? "ph-bold ph-circle-notch animate-spin" : icon) + " text-[23px]"}></i>
            </span>
          )}

          <div className="min-w-0 flex-1">
            {/* Names which of the two rooms you are looking at. */}
            <p className="caps text-ink-2">{service}</p>
            {/* The state is the headline, not a tag beside the service name.
                Which of the two this is can be told from the mark and from
                which side of the window it is on; whether it is done cannot. */}
            <h2 className={`display text-[1.9rem] sm:text-[2.2rem] leading-none mt-2.5 truncate ${
              sealed ? "text-ink-3" : intent === "neutral" ? "text-ink" : tone.figure}`}>
              {sealed && <span aria-hidden="true" className="mr-2.5 text-[0.7em]">✕</span>}
              {title}
            </h2>
            <p className="standfirst text-[13.5px] mt-3 max-w-[46ch]">{subtitle}</p>

            {/* Under the identity rather than opposite it. The half of the
                window that has settled is the narrow one, which leaves these
                about 340px, not enough to sit beside a heading without
                wrapping them a word at a time. */}
            {actions && (
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 mt-5 pt-3 border-t border-rule">
                {actions}
              </div>
            )}
          </div>
        </div>

        {children && <div className="mt-9 max-w-[540px]">{children}</div>}
      </div>
    </section>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────── */

function Quiet({ onClick, disabled, icon, label }: {
  onClick: () => void; disabled?: boolean; icon: string; label: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className="textlink caps shrink-0 hover:!text-crimson">
      <i className={icon + " text-[12px] mr-1.5"} aria-hidden="true"></i>{label}
    </button>
  );
}

function Hint({ intent, children }: { intent: Intent; children: React.ReactNode }) {
  const tone = INTENT[intent];
  return (
    <div className={`pl-3.5 pr-3 py-2.5 border-l-2 text-[12.5px] leading-relaxed ${tone.soft} ${tone.text} ${tone.border}`}>
      {children}
    </div>
  );
}

function Field({ label, optional, children }: {
  label: string; optional?: boolean; children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block caps mb-1.5">
        {label}{optional && <span className="normal-case tracking-normal font-normal text-ink-4"> · optional</span>}
      </span>
      {children}
    </label>
  );
}

/**
 * The line under a field that says which of two similar answers it wants.
 *
 * Sized to be read rather than skimmed past. Two of the three fields in the
 * profile form ask for an AWS region and mean entirely different ones, and this
 * line is the only thing on screen that tells them apart.
 */
function Aside({ children }: { children: React.ReactNode }) {
  return (
    <span className="standfirst block mt-2 text-[11.5px] leading-relaxed">
      {children}
    </span>
  );
}

function Banner({ intent, icon, title, children, onDismiss, index }: {
  intent: Intent; icon: string; title: string; children: React.ReactNode;
  onDismiss?: () => void; index: number;
}) {
  const tone = INTENT[intent];
  return (
    <div style={enter(index)} className={`border border-rule ${tone.soft}`}>
      <span className={`block h-[3px] w-full ${tone.mark}`} aria-hidden="true" />
      <div className="p-4 flex items-start gap-3.5">
        <i className={`${icon} ${tone.text} text-lg shrink-0 mt-0.5`}></i>
        <div className="flex-1 min-w-0">
          <p className={`display text-[1.0625rem] ${tone.text}`}>{title}</p>
          <p className={`text-[13px] mt-1.5 leading-relaxed ${tone.text}`}>{children}</p>
        </div>
        {onDismiss && (
          <button onClick={onDismiss} className={`textlink caps shrink-0 !${tone.text}`}>Dismiss</button>
        )}
      </div>
    </div>
  );
}
