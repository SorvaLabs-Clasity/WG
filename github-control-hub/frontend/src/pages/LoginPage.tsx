import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  getLoginUrl,
  fetchAuthStatus,
  invalidateAws,
  reconnectAws,
  triggerAwsSsoLogin,
  revokeGithub,
  fetchAwsProfiles,
  useAwsProfile,
  setAwsAccessKeys,
  verifyStoredToken,
  type AuthStatus,
  type AwsProfile,
} from "../api/auth";
import { clearToken, isAuthenticated, getUserInfo, getToken } from "../api/client";
import { useTheme } from "../hooks/useTheme";
import { INTENT, TYPE, SURFACE, EASE, enter, COMPANY_NAME, type Intent, Button, Segmented } from "../design";

/**
 * Sign-in.
 *
 * Two credentials have to be turned before the app opens, and the old page
 * buried that: a 440px column of 11px text where every element — step pills,
 * status chips, action links — competed at the same weight, on a background
 * hardcoded dark so light mode did nothing.
 *
 * Here the count of what is connected is the largest thing on the page, and
 * the two connections are full cards carrying their own state colour. You can
 * tell across a room whether you are one step away or ready.
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
  const [awsProfiles, setAwsProfiles] = useState<AwsProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [awsMethod, setAwsMethod] = useState<"sso" | "profile" | "keys">("sso");
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
   * The account this machine last signed in with. Survives quitting the app —
   * the token lives in sessionStorage and goes, the identity is kept — but is
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
    } catch { /* fall through — the worst case is the usual instant sign-in */ }
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

  // Re-read whenever AWS is not connected — on first load, and again the moment
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

  const handleAwsSsoLogin = async () => {
    setAwsSsoStarted(true);
    await triggerAwsSsoLogin(selectedProfile || undefined);
  };

  const handleReconnectAws = async () => {
    setRefreshing("aws");
    await reconnectAws(selectedProfile || undefined);
    await checkStatus();
    setAwsSsoStarted(false);
  };

  const handleUseProfile = async () => {
    if (!selectedProfile) return;
    setRefreshing("aws");
    await useAwsProfile(selectedProfile);
    await checkStatus();
  };

  const parseExportBlock = (block: string) => {
    const vals: Record<string, string> = {};
    const re = /export\s+(AWS_\w+)\s*=\s*"?([^"\s]+)"?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      vals[m[1]] = m[2];
    }
    return vals;
  };

  const handlePasteBlockConnect = async () => {
    const parsed = parseExportBlock(akPasteBlock);
    const id = parsed.AWS_ACCESS_KEY_ID;
    const secret = parsed.AWS_SECRET_ACCESS_KEY;
    if (!id || !secret) return;
    setRefreshing("aws");
    await setAwsAccessKeys({
      accessKeyId: id,
      secretAccessKey: secret,
      sessionToken: parsed.AWS_SESSION_TOKEN || undefined,
      region: parsed.AWS_DEFAULT_REGION || parsed.AWS_REGION || undefined,
    });
    await checkStatus();
  };

  const pasteBlockValid = useMemo(() => {
    const parsed = parseExportBlock(akPasteBlock);
    return !!(parsed.AWS_ACCESS_KEY_ID && parsed.AWS_SECRET_ACCESS_KEY);
  }, [akPasteBlock]);

  const handleAccessKeys = async () => {
    if (!akId || !akSecret) return;
    setRefreshing("aws");
    await setAwsAccessKeys({
      accessKeyId: akId,
      secretAccessKey: akSecret,
      sessionToken: akSession || undefined,
      region: akRegion || undefined,
    });
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
    <div className={`min-h-screen ${SURFACE.page} text-slate-900 dark:text-slate-100`}>
      <button
        onClick={toggle}
        className="fixed top-5 right-5 z-50 w-10 h-10 flex items-center justify-center rounded-xl text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-900/[0.06] dark:hover:bg-white/10 transition-colors"
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        <i className={"ph-bold " + (theme === "dark" ? "ph-sun" : "ph-moon") + " text-lg"}></i>
      </button>

      <div className="mx-auto max-w-[1080px] px-6 py-10 lg:py-20 grid lg:grid-cols-[minmax(0,1fr)_480px] gap-10 lg:gap-16 items-center min-h-screen">

        {/* ── Posture. The largest thing on the page. ── */}
        <section style={enter(0)}>
          <div className="flex items-center gap-3 mb-10">
            <div className="w-11 h-11 rounded-xl bg-slate-900 dark:bg-white flex items-center justify-center shrink-0">
              <i className="ph-fill ph-shield-check text-[21px] text-white dark:text-slate-900"></i>
            </div>
            <div>
              <div className="text-[15px] font-black tracking-tight leading-none">GitHub Control Hub</div>
              <div className="text-[12px] text-slate-500 dark:text-slate-400 mt-1">{COMPANY_NAME}</div>
            </div>
          </div>

          <Posture stage={stage} connected={connected} org={status?.github.org ?? undefined} />
        </section>

        {/* ── The two keys ── */}
        <section className="w-full space-y-3">
          {authError && !authErrorDismissed && (
            <Banner
              intent="danger"
              icon="ph-fill ph-warning-circle"
              title={authError.kind === "not_member" ? "Wrong GitHub account" : "Authentication failed"}
              onDismiss={() => setAuthErrorDismissed(true)}
              index={1}
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
            <Banner intent="danger" icon="ph-fill ph-plugs" title="Backend unreachable" index={1}>
              Nothing is responding on the local API. Make sure{" "}
              <code className="font-mono text-[12.5px] px-1.5 py-0.5 rounded bg-rose-500/15">ghch serve</code>{" "}
              is running, then reload.
            </Banner>
          )}

          {/* ── AWS ── */}
          <KeyCard
            index={2}
            intent={awsOk ? "good" : error ? "danger" : "neutral"}
            icon="ph-fill ph-cloud"
            busy={awsBusy}
            title="Amazon Web Services"
            state={awsOk ? "connected" : error ? "offline" : "waiting"}
            subtitle={
              awsOk && status?.aws.profile
                ? <>Profile <span className="font-mono font-bold text-emerald-700 dark:text-emerald-300">{status.aws.profile}</span></>
                : awsOk ? "DynamoDB and Secrets Manager reachable"
                : "Needed to read and write the app's own data"
            }
            action={awsOk && !loading && !error
              ? <Quiet onClick={handleDisconnectAws} disabled={refreshing === "aws"} icon="ph-bold ph-plugs" label="Disconnect" />
              : undefined}
          >
            {!loading && !error && !awsOk && (
              <div className="space-y-3">
                {profilesError && (
                  <Hint intent="warn">
                    Could not read your AWS profiles — {profilesError}. Access keys still work.
                  </Hint>
                )}
                <Segmented
                  value={awsMethod}
                  onChange={(v) => { touchedMethod.current = true; setAwsMethod(v); setAwsSsoStarted(false); }}
                  options={([
                    ["sso", "SSO"] as [typeof awsMethod, string],
                    ["keys", "Access keys"] as [typeof awsMethod, string],
                    ["profile", "Profile"] as [typeof awsMethod, string],
                  ]).filter(([id]) =>
                    id === "keys" ||
                    (id === "sso" && awsProfiles.some(p => p.type === "sso")) ||
                    (id === "profile" && awsProfiles.length > 0)
                  )}
                />

                {awsMethod === "sso" && (
                  <div className="space-y-2.5">
                    {awsProfiles.filter(p => p.type === "sso").length > 1 && !awsSsoStarted && (
                      <select value={selectedProfile} onChange={e => setSelectedProfile(e.target.value)} className={SURFACE.input}>
                        {awsProfiles.filter(p => p.type === "sso").map(p => (
                          <option key={p.name} value={p.name}>
                            {p.name}{p.accountId ? ` (${p.accountId})` : ""}{p.roleName ? ` — ${p.roleName}` : ""}
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
                        <Button variant="primary" onClick={handleAwsSsoLogin} className="w-full sm:w-auto">
                          <i className="ph-bold ph-browser mr-2"></i>
                          Sign in as {selectedProfile || "default"}
                        </Button>
                      ) : (
                        <>
                          <Button variant="ghost" onClick={handleAwsSsoLogin}>Reopen browser</Button>
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
                          {p.name} ({p.type}){p.accountId ? ` — ${p.accountId}` : ""}{p.roleName ? ` / ${p.roleName}` : ""}
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
                        <Field label="Region" optional>
                          <input type="text" value={akRegion} onChange={e => setAkRegion(e.target.value)}
                            placeholder="us-east-1" className={`${SURFACE.input} font-mono text-[12.5px]`} />
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
          </KeyCard>

          {/* ── GitHub ── */}
          <KeyCard
            index={3}
            intent={ghAuthed ? "good" : "neutral"}
            icon="ph-fill ph-github-logo"
            avatar={ghAuthed ? userInfo?.avatarUrl : undefined}
            busy={loading || refreshing === "github"}
            locked={!awsOk && !ghAuthed}
            title={ghAuthed && userInfo ? userInfo.login : "GitHub"}
            state={ghAuthed ? "connected" : !awsOk ? "locked" : "waiting"}
            subtitle={
              ghAuthed
                ? status?.github.org
                  ? <>Member of <span className="font-bold">{status.github.org}</span></>
                  : "Authenticated"
                : !ghConfigured ? "OAuth is not configured on this build"
                : !awsOk ? "Unlocks once AWS is connected"
                : "Your own account — the app acts as you, never as someone else"
            }
            action={!loading && !error && ghAuthed
              ? <Quiet onClick={handleSignOutGithub} disabled={signingOut}
                  icon="ph-bold ph-sign-out" label={signingOut ? "Signing out…" : "Sign out"} />
              : undefined}
          >
            {!loading && !error && !ghAuthed && ghConfigured && awsOk && (
              <div className="space-y-2.5">
                {justSignedOut && <Hint intent="neutral">Signed out. Sign in below to use a different account.</Hint>}

                {remembered ? (
                  /* GitHub still holds a session for this account, so signing in
                     completes the moment it is asked — no page, no choice. Say
                     whose account it will be before that happens, rather than
                     announcing it afterwards. */
                  <>
                    <a
                      /* Name the account. Without it GitHub signs in as
                         whichever session the browser holds, which is how
                         "Continue with alice" could produce bob. */
                      href={`${loginUrl}?login=${encodeURIComponent(remembered.login)}`}
                      className="flex items-center gap-3 w-full p-2.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 no-underline shadow-sm hover:shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all"
                    >
                      {remembered.avatarUrl
                        ? <img src={remembered.avatarUrl} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
                        : <span className="w-9 h-9 rounded-lg bg-white/15 dark:bg-slate-900/10 flex items-center justify-center shrink-0">
                            <i className="ph-fill ph-github-logo text-lg"></i>
                          </span>}
                      <span className="flex-1 min-w-0 text-left">
                        <span className="block text-[11px] uppercase tracking-[0.14em] font-bold opacity-60">Continue with</span>
                        <span className="block text-sm font-bold truncate">{remembered.login}</span>
                      </span>
                      <i className="ph-bold ph-arrow-right text-sm mr-1 opacity-70"></i>
                    </a>

                    {canSwitchAccount && (
                      <button
                        onClick={handleUseDifferentAccount}
                        disabled={switchingAccount}
                        className="w-full py-2.5 rounded-xl text-[13px] font-bold text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-900/[0.04] dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50"
                      >
                        {switchingAccount ? "Signing out of GitHub…" : "Use a different account"}
                      </button>
                    )}
                  </>
                ) : (
                  <a
                    href={loginUrl}
                    className="flex items-center justify-center gap-2.5 w-full py-3 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-bold no-underline shadow-sm hover:shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all"
                  >
                    <i className="ph-fill ph-github-logo text-base"></i>
                    Sign in with GitHub
                  </a>
                )}
              </div>
            )}
          </KeyCard>

          {/* ── Enter ── */}
          <div style={enter(4)} className="pt-2">
            <button
              onClick={() => navigate("/analytics")}
              disabled={!canEnter}
              className={
                "w-full py-4 rounded-2xl text-[15px] font-black tracking-tight transition-all flex items-center justify-center gap-2.5 " +
                (canEnter
                  ? "bg-emerald-600 text-white shadow-lg shadow-emerald-600/25 hover:shadow-xl hover:shadow-emerald-600/30 hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                  : "bg-slate-200/70 dark:bg-white/[0.06] text-slate-400 dark:text-slate-500 cursor-not-allowed")
              }
            >
              {canEnter ? <>Open the dashboard<i className="ph-bold ph-arrow-right"></i></> : "Open the dashboard"}
            </button>

            {(awsOk || ghAuthed) && !loading && !error && (
              <div className="flex justify-center mt-4">
                <button
                  onClick={handleDisconnectAll}
                  disabled={refreshing !== null}
                  className="text-[12px] font-semibold text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  <i className="ph-bold ph-power text-[13px]"></i>
                  Reset both connections
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ── Posture ─────────────────────────────────────────────────────────── */

function Posture({ stage, connected, org }: { stage: Stage; connected: number; org?: string }) {
  const copy: Record<Stage, { intent: Intent; eyebrow: string; head: string; body: React.ReactNode }> = {
    loading:  { intent: "neutral", eyebrow: "Checking",     head: "One moment",        body: "Looking at what is already connected." },
    offline:  { intent: "danger",  eyebrow: "No backend",   head: "Nothing is running", body: <>The local API is not responding, so neither connection can be checked.</> },
    aws:      { intent: "info",    eyebrow: "Step 1 of 2",  head: "Connect AWS",       body: "The app keeps its own state in DynamoDB, so it needs credentials before anything else works." },
    github:   { intent: "info",    eyebrow: "Step 2 of 2",  head: "Sign in to GitHub", body: <>Every change is made with your account, so {org ? <span className="font-bold">{org}</span> : "GitHub"} decides what you may do.</> },
    ready:    { intent: "good",    eyebrow: "Ready",        head: "Both connected",    body: "You are signed in and the dashboard is available." },
  };
  const c = copy[stage];
  const tone = INTENT[c.intent];

  return (
    <div>
      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${tone.soft} ${tone.text} ${TYPE.label} mb-6`}>
        <span className={`w-1.5 h-1.5 rounded-full ${tone.mark}`} />
        {c.eyebrow}
      </div>

      <div className="flex items-end gap-5 mb-6">
        <span className={`${TYPE.metric} ${tone.figure}`} style={{ transition: `color 400ms ${EASE}` }}>
          {connected}
        </span>
        <span className="text-[30px] font-black text-slate-300 dark:text-slate-600 leading-none pb-2">/ 2</span>
      </div>

      <h1 className="text-[34px] sm:text-[42px] font-black tracking-[-0.03em] leading-[1.02] mb-4">
        {c.head}
      </h1>
      <p className="text-[15px] leading-relaxed text-slate-500 dark:text-slate-400 max-w-[38ch]">
        {c.body}
      </p>

      <div className="hidden lg:flex items-center gap-2 mt-12">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
        <span className="text-[12px] font-semibold text-slate-400 dark:text-slate-500">
          Running locally on this machine
        </span>
      </div>
    </div>
  );
}

/* ── One connection ──────────────────────────────────────────────────── */

function KeyCard({ index, intent, icon, avatar, title, subtitle, state, busy, locked, action, children }: {
  index: number; intent: Intent; icon: string; avatar?: string;
  title: string; subtitle: React.ReactNode;
  state: "connected" | "waiting" | "locked" | "offline";
  busy?: boolean; locked?: boolean; action?: React.ReactNode; children?: React.ReactNode;
}) {
  const tone = INTENT[intent];
  const hasBody = !!children;

  return (
    <div
      style={enter(index)}
      className={`${SURFACE.card} overflow-hidden ${locked ? "opacity-60" : ""} transition-opacity duration-300`}
    >
      <div className="flex">
        {/* Colour rail — state is visible before you read a word. */}
        <div className={`w-1.5 shrink-0 ${tone.mark} transition-colors duration-300`} />

        <div className="flex-1 min-w-0 p-5">
          <div className="flex items-start gap-3.5">
            {avatar ? (
              <img src={avatar} alt={title}
                className="w-11 h-11 rounded-xl object-cover shrink-0 ring-2 ring-emerald-500/30" />
            ) : (
              <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${tone.soft} ${tone.text}`}>
                <i className={(busy ? "ph-bold ph-circle-notch animate-spin" : icon) + " text-[21px]"}></i>
              </div>
            )}

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className={`${TYPE.heading} truncate`}>{title}</h2>
                <StateTag state={state} busy={busy} />
              </div>
              <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">{subtitle}</p>
            </div>

            {action}
          </div>

          {hasBody && <div className="mt-4">{children}</div>}
        </div>
      </div>
    </div>
  );
}

function StateTag({ state, busy }: { state: "connected" | "waiting" | "locked" | "offline"; busy?: boolean }) {
  if (busy) return <Tag intent="neutral">Checking</Tag>;
  if (state === "connected") return <Tag intent="good"><i className="ph-fill ph-check-circle text-[13px]" />Connected</Tag>;
  if (state === "offline") return <Tag intent="danger">Offline</Tag>;
  if (state === "locked") return <Tag intent="neutral"><i className="ph-bold ph-lock-simple text-[12px]" />Locked</Tag>;
  return <Tag intent="info">Waiting</Tag>;
}

function Tag({ intent, children }: { intent: Intent; children: React.ReactNode }) {
  const tone = INTENT[intent];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] uppercase tracking-[0.12em] font-black ${tone.soft} ${tone.text}`}>
      {children}
    </span>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────── */

function Quiet({ onClick, disabled, icon, label }: {
  onClick: () => void; disabled?: boolean; icon: string; label: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="shrink-0 text-[12px] font-semibold text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 transition-colors flex items-center gap-1.5 disabled:opacity-50">
      <i className={icon + " text-[13px]"}></i>
      {label}
    </button>
  );
}

function Hint({ intent, children }: { intent: Intent; children: React.ReactNode }) {
  const tone = INTENT[intent];
  return (
    <div className={`px-3.5 py-2.5 rounded-xl text-[12.5px] leading-relaxed ${tone.soft} ${tone.text}`}>
      {children}
    </div>
  );
}

function Field({ label, optional, children }: {
  label: string; optional?: boolean; children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-[0.14em] font-bold text-slate-400 dark:text-slate-500 mb-1.5">
        {label}{optional && <span className="normal-case tracking-normal font-medium text-slate-300 dark:text-slate-600"> · optional</span>}
      </span>
      {children}
    </label>
  );
}

function Banner({ intent, icon, title, children, onDismiss, index }: {
  intent: Intent; icon: string; title: string; children: React.ReactNode;
  onDismiss?: () => void; index: number;
}) {
  const tone = INTENT[intent];
  return (
    <div style={enter(index)} className={`rounded-2xl border p-4 flex items-start gap-3 ${tone.soft} ${tone.border}`}>
      <i className={`${icon} ${tone.text} text-lg shrink-0 mt-0.5`}></i>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-bold ${tone.text}`}>{title}</p>
        <p className={`text-[13px] mt-1 leading-relaxed ${tone.text} opacity-90`}>{children}</p>
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className={`shrink-0 ${tone.text} opacity-50 hover:opacity-100 transition-opacity`}>
          <i className="ph-bold ph-x text-sm"></i>
        </button>
      )}
    </div>
  );
}
