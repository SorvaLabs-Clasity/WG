import { useState, useEffect, useCallback, useMemo } from "react";
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
  const [akPasteMode, setAkPasteMode] = useState(true);
  const [akPasteBlock, setAkPasteBlock] = useState("");
  const [akId, setAkId] = useState("");
  const [akSecret, setAkSecret] = useState("");
  const [akSession, setAkSession] = useState("");
  const [akRegion, setAkRegion] = useState("");

  const [ghAuthed, setGhAuthed] = useState(isAuthenticated());
  const [userInfo, setLocalUserInfo] = useState(getUserInfo());
  const [justSignedOut, setJustSignedOut] = useState(false);

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

  useEffect(() => {
    checkStatus();
    // Validate stored token against the server (JWT_SECRET changes on restart)
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
    fetchAwsProfiles().then(p => {
      setAwsProfiles(p);
      if (p.length > 0 && !selectedProfile) {
        setSelectedProfile(p[0].name);
      }
      const hasSso = p.some(pr => pr.type === "sso");
      if (!hasSso && p.length > 0) setAwsMethod("profile");
      else if (!hasSso) setAwsMethod("keys");
    }).catch(() => { setAwsMethod("keys"); });
  }, [checkStatus]);

  const awsOk = status?.aws.connected && status.aws.dynamoReachable;
  const ghConfigured = status?.github.configured;
  const canEnter = awsOk && ghAuthed;

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
    // Clear Electron's GitHub cookies so the next sign-in doesn't auto-reuse the same account
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

  const handleEnter = () => {
    navigate("/analytics");
  };

  const inputCls = "w-full text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-800 font-mono placeholder:text-slate-400 dark:placeholder:text-slate-500";

  return (
    <div className="bg-slate-50 dark:bg-slate-950 min-h-screen flex items-center justify-center p-4">
      {/* Theme toggle */}
      <button
        onClick={toggle}
        className="fixed top-4 right-4 z-50 text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors p-2 rounded-lg hover:bg-white/80 dark:hover:bg-slate-800/80 backdrop-blur"
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        <i className={"ph-bold " + (theme === "dark" ? "ph-sun" : "ph-moon") + " text-xl"}></i>
      </button>

      <main className="w-full max-w-[480px]">
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">

          {/* Header */}
          <div className="px-8 pt-10 pb-6 text-center">
            <div className="w-14 h-14 bg-slate-900 dark:bg-white rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-slate-900/10 dark:shadow-black/20">
              <i className="ph-fill ph-github-logo text-2xl text-white dark:text-slate-900"></i>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight mb-1">
              GitHub Control Hub
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Manage repositories, compliance, and security for your organization.
            </p>
          </div>

          {/* Status Checks */}
          <div className="px-8 pb-4">
            <div className="rounded-xl border border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 divide-y divide-slate-100 dark:divide-slate-700">

              {/* ── AWS ── */}
              <div className="px-4 py-3.5">
                <div className="flex items-start gap-3">
                  <div className="pt-0.5 shrink-0">
                    <StatusIcon loading={loading || refreshing === "aws"} error={error} ok={awsOk} icon="ph-fill ph-cloud" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">AWS</div>
                      <div className="shrink-0">
                        <Badge loading={loading || refreshing === "aws"} error={error} ok={awsOk}
                          okLabel="Connected" failLabel="Not Connected" />
                      </div>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">DynamoDB + Secrets Manager</div>
                  </div>
                </div>
                {!loading && !error && (
                  <>
                    {awsOk ? (
                      <div className="flex justify-end mt-2 gap-3">
                        <SmallButton onClick={handleDisconnectAws} disabled={refreshing === "aws"}
                          icon="ph-bold ph-sign-out" label="Disconnect" color="slate" hoverColor="red" />
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {/* Method tabs */}
                        <div className="flex rounded-lg border border-slate-200 dark:border-slate-600 p-0.5 bg-white dark:bg-slate-800">
                          {([
                            { id: "sso" as const, label: "SSO", show: awsProfiles.some(p => p.type === "sso") },
                            { id: "keys" as const, label: "Access Keys", show: true },
                            { id: "profile" as const, label: "Profile", show: awsProfiles.length > 0 },
                          ]).filter(t => t.show).map(t => (
                            <button key={t.id} onClick={() => { setAwsMethod(t.id); setAwsSsoStarted(false); }}
                              className={"flex-1 text-[11px] font-semibold py-1.5 rounded-md transition-colors " + (awsMethod === t.id ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900" : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200")}
                            >{t.label}</button>
                          ))}
                        </div>

                        {/* SSO method */}
                        {awsMethod === "sso" && (
                          <div className="space-y-2">
                            {awsProfiles.filter(p => p.type === "sso").length > 1 && !awsSsoStarted && (
                              <select value={selectedProfile} onChange={e => setSelectedProfile(e.target.value)}
                                className={inputCls}>
                                {awsProfiles.filter(p => p.type === "sso").map(p => (
                                  <option key={p.name} value={p.name}>
                                    {p.name}{p.accountId ? " (" + p.accountId + ")" : ""}{p.roleName ? " — " + p.roleName : ""}
                                  </option>
                                ))}
                              </select>
                            )}
                            <div className="flex justify-end gap-3">
                              {!awsSsoStarted ? (
                                <SmallButton onClick={handleAwsSsoLogin}
                                  icon="ph-bold ph-browser" label={"Sign in as " + (selectedProfile || "default")} color="blue" />
                              ) : (
                                <>
                                  <SmallButton onClick={handleAwsSsoLogin}
                                    icon="ph-bold ph-browser" label="Reopen browser" color="slate" />
                                  <SmallButton onClick={handleReconnectAws} disabled={refreshing === "aws"}
                                    icon="ph-bold ph-arrow-clockwise" label="I've signed in — Verify" color="emerald" />
                                </>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Profile method */}
                        {awsMethod === "profile" && (
                          <div className="space-y-2">
                            <select value={selectedProfile} onChange={e => setSelectedProfile(e.target.value)}
                              className={inputCls}>
                              {awsProfiles.map(p => (
                                <option key={p.name} value={p.name}>
                                  {p.name} ({p.type}){p.accountId ? " — " + p.accountId : ""}{p.roleName ? " / " + p.roleName : ""}
                                </option>
                              ))}
                            </select>
                            <div className="flex justify-end">
                              <SmallButton onClick={handleUseProfile} disabled={refreshing === "aws" || !selectedProfile}
                                icon="ph-bold ph-user-switch" label={"Use " + (selectedProfile || "profile")} color="blue" />
                            </div>
                          </div>
                        )}

                        {/* Access Keys method */}
                        {awsMethod === "keys" && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 mb-1">
                              <button onClick={() => setAkPasteMode(true)}
                                className={"text-[10px] font-semibold px-2 py-0.5 rounded-md transition-colors " + (akPasteMode ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900" : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200")}
                              >Paste Export Block</button>
                              <button onClick={() => setAkPasteMode(false)}
                                className={"text-[10px] font-semibold px-2 py-0.5 rounded-md transition-colors " + (!akPasteMode ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900" : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200")}
                              >Individual Fields</button>
                            </div>

                            {!akPasteMode ? (
                              <>
                                <input type="text" placeholder="Access Key ID" value={akId} onChange={e => setAkId(e.target.value)} className={inputCls} />
                                <input type="password" placeholder="Secret Access Key" value={akSecret} onChange={e => setAkSecret(e.target.value)} className={inputCls} />
                                <input type="password" placeholder="Session Token (optional)" value={akSession} onChange={e => setAkSession(e.target.value)} className={inputCls} />
                                <input type="text" placeholder="Region (optional, default us-east-1)" value={akRegion} onChange={e => setAkRegion(e.target.value)}
                                  className="w-full text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-800 placeholder:text-slate-400 dark:placeholder:text-slate-500" />
                                <div className="flex justify-end">
                                  <SmallButton onClick={handleAccessKeys} disabled={refreshing === "aws" || !akId || !akSecret}
                                    icon="ph-bold ph-key" label="Connect" color="blue" />
                                </div>
                              </>
                            ) : (
                              <>
                                <textarea
                                  rows={4}
                                  placeholder={'Paste your AWS credentials here, e.g.:\nexport AWS_ACCESS_KEY_ID="AKIA..."\nexport AWS_SECRET_ACCESS_KEY="wJal..."\nexport AWS_SESSION_TOKEN="IQoJ..."'}
                                  value={akPasteBlock}
                                  onChange={e => setAkPasteBlock(e.target.value)}
                                  className="w-full text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-800 font-mono resize-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
                                />
                                {akPasteBlock && !pasteBlockValid && (
                                  <p className="text-[10px] text-red-500">
                                    Could not find AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the pasted text.
                                  </p>
                                )}
                                <div className="flex justify-end">
                                  <SmallButton onClick={handlePasteBlockConnect} disabled={refreshing === "aws" || !pasteBlockValid}
                                    icon="ph-bold ph-key" label="Connect" color="blue" />
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                {awsSsoStarted && !awsOk && awsMethod === "sso" && (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-100 dark:border-blue-800">
                    <p className="text-[11px] text-blue-700 dark:text-blue-300">
                      A browser tab should have opened for AWS SSO. Complete sign-in there, then click <strong>"I've signed in — Verify"</strong>.
                    </p>
                  </div>
                )}
              </div>

              {/* ── GitHub ── */}
              <div className="px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {ghAuthed && userInfo?.avatarUrl ? (
                      <img
                        src={userInfo.avatarUrl}
                        alt={userInfo.login}
                        className="w-8 h-8 rounded-lg object-cover shrink-0 border border-slate-200 dark:border-slate-600"
                      />
                    ) : (
                      <StatusIcon loading={loading || refreshing === "github"} error={error}
                        ok={false} icon="ph-fill ph-github-logo" neutralWhenFail />
                    )}
                    <div>
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                        {ghAuthed && userInfo ? userInfo.login : "GitHub"}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {ghAuthed
                          ? status?.github.org ? "Organization: " + status.github.org : "Authenticated"
                          : justSignedOut
                            ? "Signed out — sign in again below"
                            : ghConfigured
                              ? "Sign in to connect your account"
                              : "OAuth App not configured"}
                      </div>
                    </div>
                  </div>
                  {ghAuthed ? (
                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 px-2.5 py-1 rounded-full flex items-center gap-1">
                      <i className="ph-fill ph-check-circle text-xs"></i> Authenticated
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-600 px-2.5 py-1 rounded-full">
                      Unauthenticated
                    </span>
                  )}
                </div>
                {!loading && !error && (
                  <div className="flex justify-end mt-2 gap-3">
                    {ghAuthed ? (
                      <SmallButton onClick={handleSignOutGithub} disabled={signingOut}
                        icon="ph-bold ph-sign-out" label={signingOut ? "Signing out…" : "Sign out"} color="slate" hoverColor="red" />
                    ) : ghConfigured && awsOk ? (
                      <a href={loginUrl}
                        className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors flex items-center gap-1 no-underline"
                      >
                        <i className="ph-fill ph-github-logo text-xs"></i>
                        Sign in with GitHub
                      </a>
                    ) : ghConfigured && !awsOk ? (
                      <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 flex items-center gap-1">
                        <i className="ph-fill ph-github-logo text-xs"></i>
                        Connect AWS first
                      </span>
                    ) : null}
                  </div>
                )}
                {justSignedOut && !ghAuthed && (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-600">
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Signed out successfully. Click "Sign in with GitHub" to sign in with a different account.
                    </p>
                  </div>
                )}
              </div>

            </div>

            {/* Disconnect All */}
            {!loading && !error && (awsOk || ghAuthed) && (
              <div className="flex justify-center mt-3">
                <button onClick={handleDisconnectAll} disabled={refreshing !== null}
                  className="text-[11px] font-medium text-slate-400 dark:text-slate-500 hover:text-red-500 transition-colors flex items-center gap-1 disabled:opacity-50"
                >
                  <i className="ph-bold ph-power text-xs"></i>
                  Disconnect all sessions
                </button>
              </div>
            )}

            {/* Contextual messages */}
            {error && (
              <div className="mt-4 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-100 dark:border-red-800">
                <p className="text-sm text-red-700 dark:text-red-400 font-medium flex items-center gap-2">
                  <i className="ph-fill ph-warning-circle"></i>
                  Could not reach the backend server.
                </p>
                <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                  Make sure <code className="bg-red-100 dark:bg-red-900/50 px-1 py-0.5 rounded font-mono">ghch serve</code> is running.
                </p>
              </div>
            )}

            {!error && !loading && !awsOk && !awsSsoStarted && (
              <div className="mt-4 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-100 dark:border-amber-800">
                <p className="text-sm text-amber-700 dark:text-amber-400 font-medium flex items-center gap-2">
                  <i className="ph-fill ph-warning-circle"></i>
                  AWS session is not active.
                </p>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  Click <strong>"Sign in with AWS"</strong> above to authenticate.
                </p>
              </div>
            )}
          </div>

          {/* Auth error banner */}
          {authError && !authErrorDismissed && (
            <div className="px-8 pb-4">
              <div className="px-4 py-3.5 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5">
                    <i className="ph-fill ph-warning-circle text-red-500 text-base mt-0.5 shrink-0"></i>
                    <div>
                      <p className="text-sm font-semibold text-red-800 dark:text-red-300">
                        {authError.kind === "not_member" ? "Wrong GitHub account" : "Authentication failed"}
                      </p>
                      <p className="text-xs text-red-700 dark:text-red-400 mt-1">
                        {authError.kind === "not_member"
                          ? <>You signed in as <span className="font-mono font-semibold">@{authError.login}</span>, but that account is not a member of <span className="font-semibold">{authError.org}</span>.</>
                          : authError.detail || "Something went wrong during authentication."}
                      </p>
                    </div>
                  </div>
                  <button onClick={() => setAuthErrorDismissed(true)}
                    className="text-red-400 hover:text-red-600 transition-colors shrink-0 mt-0.5">
                    <i className="ph-bold ph-x text-sm"></i>
                  </button>
                </div>
                {authError.kind === "not_member" && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-2 pl-6">
                    Click <strong>"Sign in with GitHub"</strong> above to try a different account.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Enter button */}
          <div className="px-8 pb-10">
            {canEnter ? (
              <button onClick={handleEnter}
                className="w-full bg-slate-900 dark:bg-white hover:bg-slate-800 dark:hover:bg-slate-100 text-white dark:text-slate-900 font-medium py-3 px-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2.5 shadow-sm hover:shadow-md cursor-pointer"
              >
                Sign in HERE
              </button>
            ) : (
              <button disabled
                className="w-full bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-2.5 cursor-not-allowed"
              >
                Sign in HERE
              </button>
            )}
            {canEnter && (
              <p className="text-center text-xs text-slate-400 dark:text-slate-500 mt-3">
                Both sessions are active. Click to enter the dashboard.
              </p>
            )}
            {!canEnter && !loading && !error && (
              <p className="text-center text-xs text-slate-400 dark:text-slate-500 mt-3">
                {!awsOk && !ghAuthed
                  ? "Connect both AWS and GitHub above to continue."
                  : !awsOk
                    ? "Connect to AWS above to continue."
                    : "Sign in with GitHub above to continue."}
              </p>
            )}
          </div>

        </div>

        <div className="text-center mt-6">
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Running locally
          </p>
        </div>
      </main>
    </div>
  );
}

/* ── Shared UI components ── */

function StatusIcon({ loading, error, ok, icon, neutralWhenFail }: {
  loading: boolean; error: boolean; ok: boolean | undefined; icon: string; neutralWhenFail?: boolean;
}) {
  const bg = loading ? "bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500"
    : error ? "bg-red-50 dark:bg-red-950/50 text-red-500"
    : ok ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400"
    : neutralWhenFail ? "bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400"
    : "bg-red-50 dark:bg-red-950/50 text-red-500";
  const iconClass = loading ? "ph-bold ph-circle-notch animate-spin" : icon;
  return (
    <div className={"w-8 h-8 rounded-lg flex items-center justify-center shrink-0 " + bg}>
      <i className={iconClass + " text-base"}></i>
    </div>
  );
}

function Badge({ loading, error, ok, okLabel, failLabel }: {
  loading: boolean; error: boolean; ok: boolean | undefined; okLabel: string; failLabel: string;
}) {
  if (loading) return <span className="text-xs font-medium text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-700 px-2.5 py-1 rounded-full">Checking…</span>;
  if (error) return <span className="text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 px-2.5 py-1 rounded-full">Offline</span>;
  if (ok) return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 px-2.5 py-1 rounded-full flex items-center gap-1"><i className="ph-fill ph-check-circle text-xs"></i> {okLabel}</span>;
  return <span className="text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 px-2.5 py-1 rounded-full flex items-center gap-1"><i className="ph-fill ph-x-circle text-xs"></i> {failLabel}</span>;
}

function SmallButton({ onClick, disabled, icon, label, color, hoverColor }: {
  onClick: () => void; disabled?: boolean; icon: string; label: string;
  color: "slate" | "blue" | "emerald" | "red"; hoverColor?: "red" | "blue";
}) {
  const colorMap: Record<string, string> = {
    slate: "text-slate-400 dark:text-slate-500",
    blue: "text-blue-600 dark:text-blue-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
    red: "text-red-600 dark:text-red-400",
  };
  const hoverColorMap: Record<string, string> = {
    slate: "hover:text-slate-400 dark:hover:text-slate-500",
    blue: "hover:text-blue-700 dark:hover:text-blue-300",
    emerald: "hover:text-emerald-700 dark:hover:text-emerald-300",
    red: "hover:text-red-600 dark:hover:text-red-400",
  };
  const hoverCls = hoverColor ? hoverColorMap[hoverColor] : hoverColorMap[color];
  return (
    <button onClick={onClick} disabled={disabled}
      className={"text-[11px] font-medium " + colorMap[color] + " " + hoverCls + " transition-colors flex items-center gap-1 disabled:opacity-50"}
    >
      <i className={icon + " text-xs"}></i>
      {label}
    </button>
  );
}
