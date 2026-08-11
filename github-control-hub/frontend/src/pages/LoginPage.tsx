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

  const inputCls = "w-full text-[13px] bg-white dark:bg-[#0c1222] border border-slate-200 dark:border-slate-700/80 rounded-lg px-3.5 py-2.5 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 dark:focus:ring-blue-400/20 dark:focus:border-blue-400/40 font-mono placeholder:text-slate-400 dark:placeholder:text-slate-600 transition-all";

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden bg-[#11131a]">
      {/* Ambient background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Flat geometry rather than blurred colour blobs — the gradient-orb
            look is the thing that dates an interface fastest. */}
        <div className="absolute -top-40 -left-40 w-[520px] h-[520px] rounded-full border border-white/[0.06]" />
        <div className="absolute -top-24 -left-24 w-[420px] h-[420px] rounded-full border border-white/[0.05]" />
        <div className="absolute -bottom-52 -right-40 w-[560px] h-[560px] rounded-full bg-white/[0.02]" />
      </div>

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.03] dark:opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(148,163,184,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.5) 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
        }}
      />

      {/* Theme toggle */}
      <button
        onClick={toggle}
        className="fixed top-5 right-5 z-50 w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white transition-all hover:bg-white/80 dark:hover:bg-white/5 backdrop-blur-sm border border-transparent hover:border-slate-200 dark:hover:border-slate-700/60"
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        <i className={"ph-bold " + (theme === "dark" ? "ph-sun" : "ph-moon") + " text-lg"}></i>
      </button>

      <main className="w-full max-w-[440px] relative z-10">
        {/* Main card */}
        <div className="bg-white/90 dark:bg-[#0d1424]/90 backdrop-blur-xl rounded-2xl border border-slate-200/80 dark:border-slate-700/50 shadow-xl shadow-slate-900/5 dark:shadow-black/30 overflow-hidden">

          {/* Header */}
          <div className="px-8 pt-10 pb-7 text-center relative">
            <div className="w-[52px] h-[52px] bg-slate-900 dark:bg-white rounded-[14px] flex items-center justify-center mx-auto mb-5 shadow-lg shadow-slate-900/15 dark:shadow-black/30 relative">
              <i className="ph-fill ph-github-logo text-[22px] text-white dark:text-slate-900"></i>
              {canEnter && (
                <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-emerald-500 rounded-full border-2 border-white dark:border-[#0d1424] flex items-center justify-center">
                  <i className="ph-bold ph-check text-[8px] text-white"></i>
                </div>
              )}
            </div>
            <h1 className="text-[22px] font-bold text-slate-900 dark:text-white tracking-tight mb-1">
              GitHub Control Hub
            </h1>
            <p className="text-[13px] text-slate-500 dark:text-slate-500 leading-relaxed">
              Repository compliance & security management
            </p>
          </div>

          {/* Step indicators */}
          <div className="px-8 pb-2">
            <div className="flex items-center gap-2">
              <StepPill
                step={1}
                label="AWS"
                active={!awsOk}
                done={!!awsOk}
                loading={loading || refreshing === "aws"}
              />
              <div className={"h-px flex-1 transition-colors duration-300 " + (awsOk ? "bg-emerald-300 dark:bg-emerald-700" : "bg-slate-200 dark:bg-slate-700")} />
              <StepPill
                step={2}
                label="GitHub"
                active={!!awsOk && !ghAuthed}
                done={ghAuthed}
                loading={loading || refreshing === "github"}
              />
            </div>
          </div>

          {/* Connection panels */}
          <div className="px-8 pt-4 pb-2 space-y-3">

            {/* ── AWS Panel ── */}
            <div className={
              "rounded-xl border transition-all duration-300 overflow-hidden " +
              (awsOk
                ? "border-emerald-200/80 dark:border-emerald-800/40 bg-emerald-50/50 dark:bg-emerald-950/20"
                : error
                  ? "border-red-200/80 dark:border-red-800/40 bg-red-50/30 dark:bg-red-950/10"
                  : "border-slate-200 dark:border-slate-700/60 bg-slate-50/50 dark:bg-slate-800/30")
            }>
              <div className="px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={
                      "w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-300 " +
                      (loading || refreshing === "aws"
                        ? "bg-slate-100 dark:bg-slate-700/50 text-slate-400"
                        : awsOk
                          ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400"
                          : "bg-slate-100 dark:bg-slate-700/50 text-slate-400 dark:text-slate-500")
                    }>
                      <i className={(loading || refreshing === "aws" ? "ph-bold ph-circle-notch animate-spin" : "ph-fill ph-cloud") + " text-lg"}></i>
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">Amazon Web Services</div>
                      <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5">
                        {awsOk && status?.aws.profile
                          ? <>Profile: <span className="font-mono text-slate-600 dark:text-slate-400">{status.aws.profile}</span></>
                          : awsOk
                            ? "DynamoDB + Secrets Manager"
                            : "Connect to continue"}
                      </div>
                    </div>
                  </div>
                  <StatusChip loading={loading || refreshing === "aws"} error={error} ok={awsOk} />
                </div>

                {!loading && !error && (
                  <>
                    {awsOk ? (
                      <div className="flex justify-end mt-2 pt-2 border-t border-emerald-200/50 dark:border-emerald-800/30">
                        <ActionLink onClick={handleDisconnectAws} disabled={refreshing === "aws"}
                          icon="ph-bold ph-sign-out" label="Disconnect" variant="danger" />
                      </div>
                    ) : (
                      <div className="mt-3 pt-3 border-t border-slate-200/80 dark:border-slate-700/40 space-y-3">
                        {/* Method tabs */}
                        <div className="flex rounded-lg bg-slate-100 dark:bg-slate-800/80 p-0.5">
                          {([
                            { id: "sso" as const, label: "SSO", show: awsProfiles.some(p => p.type === "sso") },
                            { id: "keys" as const, label: "Access Keys", show: true },
                            { id: "profile" as const, label: "Profile", show: awsProfiles.length > 0 },
                          ]).filter(t => t.show).map(t => (
                            <button key={t.id} onClick={() => { setAwsMethod(t.id); setAwsSsoStarted(false); }}
                              className={"flex-1 text-[11px] font-semibold py-1.5 rounded-md transition-all duration-200 " +
                                (awsMethod === t.id
                                  ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm"
                                  : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300")}
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
                                    {p.name}{p.accountId ? " (" + p.accountId + ")" : ""}{p.roleName ? " \u2014 " + p.roleName : ""}
                                  </option>
                                ))}
                              </select>
                            )}
                            <div className="flex justify-end gap-3">
                              {!awsSsoStarted ? (
                                <ConnectButton onClick={handleAwsSsoLogin}
                                  icon="ph-bold ph-browser" label={"Sign in as " + (selectedProfile || "default")} />
                              ) : (
                                <>
                                  <ActionLink onClick={handleAwsSsoLogin}
                                    icon="ph-bold ph-browser" label="Reopen browser" variant="muted" />
                                  <ConnectButton onClick={handleReconnectAws} disabled={refreshing === "aws"}
                                    icon="ph-bold ph-arrow-clockwise" label="Verify" />
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
                                  {p.name} ({p.type}){p.accountId ? " \u2014 " + p.accountId : ""}{p.roleName ? " / " + p.roleName : ""}
                                </option>
                              ))}
                            </select>
                            <div className="flex justify-end">
                              <ConnectButton onClick={handleUseProfile} disabled={refreshing === "aws" || !selectedProfile}
                                icon="ph-bold ph-user-switch" label={"Use " + (selectedProfile || "profile")} />
                            </div>
                          </div>
                        )}

                        {/* Access Keys method */}
                        {awsMethod === "keys" && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5 mb-1">
                              <button onClick={() => setAkPasteMode(true)}
                                className={"text-[10px] font-semibold px-2.5 py-1 rounded-md transition-all " +
                                  (akPasteMode
                                    ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-sm"
                                    : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 bg-slate-100/50 dark:bg-slate-800/50")}
                              >Paste Block</button>
                              <button onClick={() => setAkPasteMode(false)}
                                className={"text-[10px] font-semibold px-2.5 py-1 rounded-md transition-all " +
                                  (!akPasteMode
                                    ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-sm"
                                    : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 bg-slate-100/50 dark:bg-slate-800/50")}
                              >Manual Entry</button>
                            </div>

                            {!akPasteMode ? (
                              <>
                                <input type="text" placeholder="Access Key ID" value={akId} onChange={e => setAkId(e.target.value)} className={inputCls} />
                                <input type="password" placeholder="Secret Access Key" value={akSecret} onChange={e => setAkSecret(e.target.value)} className={inputCls} />
                                <input type="password" placeholder="Session Token (optional)" value={akSession} onChange={e => setAkSession(e.target.value)} className={inputCls} />
                                <input type="text" placeholder="Region (optional, default us-east-1)" value={akRegion} onChange={e => setAkRegion(e.target.value)} className={inputCls} />
                                <div className="flex justify-end">
                                  <ConnectButton onClick={handleAccessKeys} disabled={refreshing === "aws" || !akId || !akSecret}
                                    icon="ph-bold ph-key" label="Connect" />
                                </div>
                              </>
                            ) : (
                              <>
                                <textarea
                                  rows={4}
                                  placeholder={'Paste your AWS credentials here, e.g.:\nexport AWS_ACCESS_KEY_ID="AKIA..."\nexport AWS_SECRET_ACCESS_KEY="wJal..."\nexport AWS_SESSION_TOKEN="IQoJ..."'}
                                  value={akPasteBlock}
                                  onChange={e => setAkPasteBlock(e.target.value)}
                                  className={inputCls + " resize-none"}
                                />
                                {akPasteBlock && !pasteBlockValid && (
                                  <p className="text-[11px] text-red-500 dark:text-red-400 flex items-center gap-1">
                                    <i className="ph-bold ph-warning text-xs"></i>
                                    Could not parse AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
                                  </p>
                                )}
                                <div className="flex justify-end">
                                  <ConnectButton onClick={handlePasteBlockConnect} disabled={refreshing === "aws" || !pasteBlockValid}
                                    icon="ph-bold ph-key" label="Connect" />
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
                  <div className="mt-3 px-3 py-2.5 rounded-lg bg-blue-50/80 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-800/40">
                    <p className="text-[11px] text-blue-700 dark:text-blue-400 leading-relaxed">
                      A browser tab should have opened for AWS SSO. Complete sign-in there, then click <strong>"Verify"</strong>.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* ── GitHub Panel ── */}
            <div className={
              "rounded-xl border transition-all duration-300 overflow-hidden " +
              (ghAuthed
                ? "border-emerald-200/80 dark:border-emerald-800/40 bg-emerald-50/50 dark:bg-emerald-950/20"
                : "border-slate-200 dark:border-slate-700/60 bg-slate-50/50 dark:bg-slate-800/30")
            }>
              <div className="px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {ghAuthed && userInfo?.avatarUrl ? (
                      <img
                        src={userInfo.avatarUrl}
                        alt={userInfo.login}
                        className="w-9 h-9 rounded-lg object-cover shrink-0 border-2 border-emerald-200 dark:border-emerald-700/60 shadow-sm"
                      />
                    ) : (
                      <div className={
                        "w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-300 " +
                        (loading || refreshing === "github"
                          ? "bg-slate-100 dark:bg-slate-700/50 text-slate-400"
                          : "bg-slate-100 dark:bg-slate-700/50 text-slate-400 dark:text-slate-500")
                      }>
                        <i className={(loading || refreshing === "github" ? "ph-bold ph-circle-notch animate-spin" : "ph-fill ph-github-logo") + " text-lg"}></i>
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                        {ghAuthed && userInfo ? userInfo.login : "GitHub"}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5">
                        {ghAuthed
                          ? status?.github.org
                            ? <>{status.github.org}</>
                            : "Authenticated"
                          : justSignedOut
                            ? "Signed out successfully"
                            : ghConfigured
                              ? "Sign in to connect"
                              : "OAuth not configured"}
                      </div>
                    </div>
                  </div>
                  {ghAuthed ? (
                    <StatusChip loading={false} error={false} ok={true} />
                  ) : (
                    <StatusChip loading={loading || refreshing === "github"} error={error} ok={false} />
                  )}
                </div>

                {!loading && !error && (
                  <div className="flex justify-end mt-2 pt-2 border-t border-slate-200/50 dark:border-slate-700/30">
                    {ghAuthed ? (
                      <ActionLink onClick={handleSignOutGithub} disabled={signingOut}
                        icon="ph-bold ph-sign-out" label={signingOut ? "Signing out\u2026" : "Sign out"} variant="danger" />
                    ) : ghConfigured && awsOk ? (
                      <a href={loginUrl}
                        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors no-underline"
                      >
                        <i className="ph-fill ph-github-logo text-sm"></i>
                        Sign in with GitHub
                      </a>
                    ) : ghConfigured && !awsOk ? (
                      <span className="text-[12px] font-medium text-slate-400 dark:text-slate-600 flex items-center gap-1.5">
                        <i className="ph-bold ph-lock-simple text-xs"></i>
                        Connect AWS first
                      </span>
                    ) : null}
                  </div>
                )}

                {justSignedOut && !ghAuthed && (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-slate-100/80 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/40">
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                      Click "Sign in with GitHub" above to use a different account.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Disconnect All */}
          {!loading && !error && (awsOk || ghAuthed) && (
            <div className="flex justify-center pt-1 pb-1">
              <button onClick={handleDisconnectAll} disabled={refreshing !== null}
                className="text-[11px] font-medium text-slate-400 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 transition-colors flex items-center gap-1 disabled:opacity-50 py-1"
              >
                <i className="ph-bold ph-power text-xs"></i>
                Reset all connections
              </button>
            </div>
          )}

          {/* Error states */}
          {error && (
            <div className="px-8 pb-2">
              <div className="px-4 py-3 rounded-xl bg-red-50/80 dark:bg-red-950/20 border border-red-200/60 dark:border-red-800/40">
                <p className="text-sm text-red-700 dark:text-red-400 font-medium flex items-center gap-2">
                  <i className="ph-fill ph-warning-circle"></i>
                  Backend unreachable
                </p>
                <p className="text-xs text-red-600/80 dark:text-red-400/60 mt-1">
                  Make sure <code className="bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded font-mono text-[11px]">ghch serve</code> is running.
                </p>
              </div>
            </div>
          )}

          {/* Auth error banner */}
          {authError && !authErrorDismissed && (
            <div className="px-8 pb-2">
              <div className="px-4 py-3.5 rounded-xl bg-red-50/80 dark:bg-red-950/20 border border-red-200/60 dark:border-red-800/40">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5">
                    <i className="ph-fill ph-warning-circle text-red-500 text-base mt-0.5 shrink-0"></i>
                    <div>
                      <p className="text-sm font-semibold text-red-800 dark:text-red-300">
                        {authError.kind === "not_member" ? "Wrong GitHub account" : "Authentication failed"}
                      </p>
                      <p className="text-xs text-red-700 dark:text-red-400 mt-1 leading-relaxed">
                        {authError.kind === "not_member"
                          ? <>Signed in as <span className="font-mono font-semibold">@{authError.login}</span>, which is not a member of <span className="font-semibold">{authError.org}</span>.</>
                          : authError.detail || "Something went wrong during authentication."}
                      </p>
                    </div>
                  </div>
                  <button onClick={() => setAuthErrorDismissed(true)}
                    className="text-red-400 hover:text-red-600 transition-colors shrink-0 mt-0.5">
                    <i className="ph-bold ph-x text-sm"></i>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Enter button */}
          <div className="px-8 pt-4 pb-8">
            {canEnter ? (
              <button onClick={handleEnter}
                className="group w-full relative bg-slate-900 dark:bg-white hover:bg-slate-800 dark:hover:bg-slate-50 text-white dark:text-slate-900 font-semibold py-3 px-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2.5 shadow-lg shadow-slate-900/10 dark:shadow-black/10 hover:shadow-xl hover:shadow-slate-900/15 dark:hover:shadow-black/15 cursor-pointer active:scale-[0.98]"
              >
                Enter Dashboard
                <i className="ph-bold ph-arrow-right text-sm transition-transform group-hover:translate-x-0.5"></i>
              </button>
            ) : (
              <button disabled
                className="w-full bg-slate-100 dark:bg-slate-800/50 text-slate-400 dark:text-slate-600 font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-2.5 cursor-not-allowed border border-slate-200/50 dark:border-slate-700/30"
              >
                Enter Dashboard
              </button>
            )}
            {!canEnter && !loading && !error && (
              <p className="text-center text-[11px] text-slate-400 dark:text-slate-600 mt-3">
                {!awsOk && !ghAuthed
                  ? "Connect AWS and GitHub to continue"
                  : !awsOk
                    ? "Step 1: Connect to AWS"
                    : "Step 2: Sign in with GitHub"}
              </p>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="text-center mt-5 flex items-center justify-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/60 dark:bg-emerald-500/40 animate-pulse"></div>
          <p className="text-[11px] text-slate-400 dark:text-slate-600 font-medium tracking-wide">
            Running locally
          </p>
        </div>
      </main>
    </div>
  );
}

/* ── Shared UI components ── */

function StepPill({ step, label, active, done, loading }: {
  step: number; label: string; active: boolean; done: boolean; loading: boolean;
}) {
  return (
    <div className={
      "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold transition-all duration-300 " +
      (done
        ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/40"
        : active
          ? "bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border border-blue-200/60 dark:border-blue-800/40"
          : "bg-slate-100 dark:bg-slate-800/50 text-slate-400 dark:text-slate-600 border border-slate-200/50 dark:border-slate-700/30")
    }>
      {loading ? (
        <i className="ph-bold ph-circle-notch animate-spin text-xs"></i>
      ) : done ? (
        <i className="ph-bold ph-check text-xs"></i>
      ) : (
        <span className="text-[10px] tabular-nums">{step}</span>
      )}
      {label}
    </div>
  );
}

function StatusChip({ loading, error, ok }: {
  loading: boolean; error: boolean; ok: boolean | undefined;
}) {
  if (loading) return (
    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800/60 px-2.5 py-1 rounded-full border border-slate-200/50 dark:border-slate-700/30">
      Checking
    </span>
  );
  if (error) return (
    <span className="text-[11px] font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 px-2.5 py-1 rounded-full border border-red-200/60 dark:border-red-800/40">
      Offline
    </span>
  );
  if (ok) return (
    <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/20 px-2.5 py-1 rounded-full flex items-center gap-1 border border-emerald-200/60 dark:border-emerald-800/40">
      <i className="ph-fill ph-check-circle text-xs"></i> Connected
    </span>
  );
  return (
    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800/60 px-2.5 py-1 rounded-full border border-slate-200/50 dark:border-slate-700/30">
      Waiting
    </span>
  );
}

function ActionLink({ onClick, disabled, icon, label, variant }: {
  onClick: () => void; disabled?: boolean; icon: string; label: string;
  variant: "danger" | "muted";
}) {
  const cls = variant === "danger"
    ? "text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400"
    : "text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300";
  return (
    <button onClick={onClick} disabled={disabled}
      className={"text-[11px] font-medium " + cls + " transition-colors flex items-center gap-1 disabled:opacity-50"}
    >
      <i className={icon + " text-xs"}></i>
      {label}
    </button>
  );
}

function ConnectButton({ onClick, disabled, icon, label }: {
  onClick: () => void; disabled?: boolean; icon: string; label: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="text-[11px] font-semibold bg-blue-600 dark:bg-blue-500 hover:bg-blue-700 dark:hover:bg-blue-400 text-white px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow active:scale-[0.97]"
    >
      <i className={icon + " text-xs"}></i>
      {label}
    </button>
  );
}
