import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  getLoginUrl,
  fetchAuthStatus,
  invalidateAws,
  reconnectAws,
  triggerAwsSsoLogin,
  revokeGithub,
  type AuthStatus,
} from "../api/auth";
import { clearToken, isAuthenticated, getUserInfo, getToken } from "../api/client";

export default function LoginPage() {
  const navigate = useNavigate();
  const loginUrl = getLoginUrl();

  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState<"aws" | "github" | null>(null);
  const [awsSsoStarted, setAwsSsoStarted] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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
    await triggerAwsSsoLogin();
  };

  const handleReconnectAws = async () => {
    setRefreshing("aws");
    await reconnectAws();
    await checkStatus();
    setAwsSsoStarted(false);
  };

  /* ── GitHub handlers ── */
  const handleSignOutGithub = async () => {
    setSigningOut(true);
    const token = getToken();
    if (token) {
      try { await revokeGithub(token); } catch {}
    }
    clearToken();
    setGhAuthed(false);
    setLocalUserInfo(null);
    setSigningOut(false);
    setJustSignedOut(true);
  };

  const handleEnter = () => {
    navigate("/analytics");
  };

  return (
    <div className="bg-slate-50 min-h-screen flex items-center justify-center p-4">
      <main className="w-full max-w-[480px]">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">

          {/* Header */}
          <div className="px-8 pt-10 pb-6 text-center">
            <div className="w-14 h-14 bg-slate-900 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-slate-900/10">
              <i className="ph-fill ph-github-logo text-2xl text-white"></i>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight mb-1">
              GitHub Control Hub
            </h1>
            <p className="text-sm text-slate-500">
              Manage repositories, compliance, and security for your organization.
            </p>
          </div>

          {/* Status Checks */}
          <div className="px-8 pb-4">
            <div className="rounded-xl border border-slate-100 bg-slate-50/50 divide-y divide-slate-100">

              {/* ── AWS ── */}
              <div className="px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <StatusIcon loading={loading || refreshing === "aws"} error={error} ok={awsOk} icon="ph-fill ph-cloud" />
                    <div>
                      <div className="text-sm font-semibold text-slate-800">AWS</div>
                      <div className="text-xs text-slate-500">DynamoDB + Secrets Manager</div>
                    </div>
                  </div>
                  <Badge loading={loading || refreshing === "aws"} error={error} ok={awsOk}
                    okLabel="Connected" failLabel="Not Connected" />
                </div>
                {!loading && !error && (
                  <div className="flex justify-end mt-2 gap-3">
                    {awsOk ? (
                      <SmallButton onClick={handleDisconnectAws} disabled={refreshing === "aws"}
                        icon="ph-bold ph-sign-out" label="Disconnect" color="slate" hoverColor="red" />
                    ) : (
                      <>
                        {!awsSsoStarted ? (
                          <SmallButton onClick={handleAwsSsoLogin}
                            icon="ph-bold ph-browser" label="Sign in with AWS" color="blue" />
                        ) : (
                          <SmallButton onClick={handleReconnectAws} disabled={refreshing === "aws"}
                            icon="ph-bold ph-arrow-clockwise" label="I've signed in — Verify" color="emerald" />
                        )}
                      </>
                    )}
                  </div>
                )}
                {awsSsoStarted && !awsOk && (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100">
                    <p className="text-[11px] text-blue-700">
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
                        className="w-8 h-8 rounded-lg object-cover shrink-0 border border-slate-200"
                      />
                    ) : (
                      <StatusIcon loading={loading || refreshing === "github"} error={error}
                        ok={false} icon="ph-fill ph-github-logo" neutralWhenFail />
                    )}
                    <div>
                      <div className="text-sm font-semibold text-slate-800">
                        {ghAuthed && userInfo ? userInfo.login : "GitHub"}
                      </div>
                      <div className="text-xs text-slate-500">
                        {ghAuthed
                          ? status?.github.org ? `Organization: ${status.github.org}` : "Authenticated"
                          : justSignedOut
                            ? "Signed out — sign in again below"
                            : ghConfigured
                              ? "Sign in to connect your account"
                              : "OAuth App not configured"}
                      </div>
                    </div>
                  </div>
                  {ghAuthed ? (
                    <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full flex items-center gap-1">
                      <i className="ph-fill ph-check-circle text-xs"></i> Authenticated
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-slate-500 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-full">
                      Unauthenticated
                    </span>
                  )}
                </div>
                {!loading && !error && (
                  <div className="flex justify-end mt-2 gap-3">
                    {ghAuthed ? (
                      <SmallButton onClick={handleSignOutGithub} disabled={signingOut}
                        icon="ph-bold ph-sign-out" label={signingOut ? "Signing out…" : "Sign out"} color="slate" hoverColor="red" />
                    ) : ghConfigured ? (
                      <a href={loginUrl}
                        className="text-[11px] font-medium text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 no-underline"
                      >
                        <i className="ph-fill ph-github-logo text-xs"></i>
                        Sign in with GitHub
                      </a>
                    ) : null}
                  </div>
                )}
                {justSignedOut && !ghAuthed && (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
                    <p className="text-[11px] text-slate-500">
                      To use a different account, <a href="https://github.com/logout" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline underline-offset-2">sign out of GitHub</a> in your browser first.
                    </p>
                  </div>
                )}
              </div>

            </div>

            {/* Contextual messages */}
            {error && (
              <div className="mt-4 px-4 py-3 rounded-lg bg-red-50 border border-red-100">
                <p className="text-sm text-red-700 font-medium flex items-center gap-2">
                  <i className="ph-fill ph-warning-circle"></i>
                  Could not reach the backend server.
                </p>
                <p className="text-xs text-red-600 mt-1">
                  Make sure <code className="bg-red-100 px-1 py-0.5 rounded font-mono">ghch serve</code> is running.
                </p>
              </div>
            )}

            {!error && !loading && !awsOk && !awsSsoStarted && (
              <div className="mt-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-100">
                <p className="text-sm text-amber-700 font-medium flex items-center gap-2">
                  <i className="ph-fill ph-warning-circle"></i>
                  AWS session is not active.
                </p>
                <p className="text-xs text-amber-600 mt-1">
                  Click <strong>"Sign in with AWS"</strong> above to authenticate.
                </p>
              </div>
            )}
          </div>

          {/* Auth error banner */}
          {authError && !authErrorDismissed && (
            <div className="px-8 pb-4">
              <div className="px-4 py-3.5 rounded-xl bg-red-50 border border-red-200">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5">
                    <i className="ph-fill ph-warning-circle text-red-500 text-base mt-0.5 shrink-0"></i>
                    <div>
                      <p className="text-sm font-semibold text-red-800">
                        {authError.kind === "not_member" ? "Wrong GitHub account" : "Authentication failed"}
                      </p>
                      <p className="text-xs text-red-700 mt-1">
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
                  <p className="text-xs text-red-600 mt-2 pl-6">
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
                className="w-full bg-slate-900 hover:bg-slate-800 text-white font-medium py-3 px-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2.5 shadow-sm hover:shadow-md cursor-pointer"
              >
                Sign in
              </button>
            ) : (
              <button disabled
                className="w-full bg-slate-200 text-slate-400 font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-2.5 cursor-not-allowed"
              >
                Sign in
              </button>
            )}
            {canEnter && (
              <p className="text-center text-xs text-slate-400 mt-3">
                Both sessions are active. Click to enter the dashboard.
              </p>
            )}
            {!canEnter && !loading && !error && (
              <p className="text-center text-xs text-slate-400 mt-3">
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
          <p className="text-xs text-slate-400">
            Running locally &middot; No Lambda required
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
  const bg = loading ? "bg-slate-100 text-slate-400"
    : error ? "bg-red-50 text-red-500"
    : ok ? "bg-emerald-50 text-emerald-600"
    : neutralWhenFail ? "bg-slate-100 text-slate-500"
    : "bg-red-50 text-red-500";
  const iconClass = loading ? "ph-bold ph-circle-notch animate-spin" : icon;
  return (
    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${bg}`}>
      <i className={`${iconClass} text-base`}></i>
    </div>
  );
}

function Badge({ loading, error, ok, okLabel, failLabel }: {
  loading: boolean; error: boolean; ok: boolean | undefined; okLabel: string; failLabel: string;
}) {
  if (loading) return <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full">Checking…</span>;
  if (error) return <span className="text-xs font-medium text-red-600 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full">Offline</span>;
  if (ok) return <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full flex items-center gap-1"><i className="ph-fill ph-check-circle text-xs"></i> {okLabel}</span>;
  return <span className="text-xs font-medium text-red-600 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full flex items-center gap-1"><i className="ph-fill ph-x-circle text-xs"></i> {failLabel}</span>;
}

function SmallButton({ onClick, disabled, icon, label, color, hoverColor }: {
  onClick: () => void; disabled?: boolean; icon: string; label: string;
  color: "slate" | "blue" | "emerald" | "red"; hoverColor?: "red" | "blue";
}) {
  const colorMap: Record<string, string> = {
    slate: "text-slate-400",
    blue: "text-blue-600",
    emerald: "text-emerald-600",
    red: "text-red-600",
  };
  const hoverMap: Record<string, string> = {
    red: "hover:text-red-600",
    blue: "hover:text-blue-700",
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`text-[11px] font-medium ${colorMap[color]} ${hoverColor ? hoverMap[hoverColor] : `hover:${colorMap[color]}`} transition-colors flex items-center gap-1 disabled:opacity-50`}
    >
      <i className={`${icon} text-xs`}></i>
      {label}
    </button>
  );
}
