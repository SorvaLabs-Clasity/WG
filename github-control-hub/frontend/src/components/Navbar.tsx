import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import AwsAccountSwitcher from "./AwsAccountSwitcher";
import UserAvatar from "./UserAvatar";
import { useTheme } from "../hooks/useTheme";
import { revokeGithub } from "../api/auth";
import { clearToken, getToken } from "../api/client";
import { COMPANY_NAME } from "../design";
import { useQuery } from "@tanstack/react-query";
import { fetchAuthStatus } from "../api/auth";

interface NavbarProps {
  login?: string;
  avatarUrl?: string;
}

/**
 * Primary navigation.
 *
 * Follows the theme: light on light, dark on dark. It was previously pinned to
 * a dark colour, which left it unchanged when the theme was toggled and looked
 * like the switch had failed.
 *
 * The active item is a solid pill rather than an underline, so the current
 * location is obvious at a glance instead of needing to be hunted for.
 */
/**
 * Which tabs survive when GitHub is confined to another AWS account.
 *
 * The backend refuses every GitHub route in that case, so a tab left in the bar
 * is a button that leads to a 403 — and the 403 explains itself, but only after
 * a page has half-loaded. Hiding them is presentation; the refusal is the
 * restriction, and it holds whether or not this list is right.
 *
 * Activity stays, and shows only the AWS rows. It is the one feed carrying both
 * halves, and an account running guardrails needs the record of what they did —
 * which is most of the reason to run them. The server does that filtering.
 */
const ALWAYS_AVAILABLE = new Set(["/aws", "/activity"]);

const ITEMS = [
  { label: "Overview", short: "Overview", icon: "ph-chart-line-up", path: "/analytics", match: (p: string) => p === "/" || p.startsWith("/analytics") },
  { label: "AWS", short: "AWS", icon: "ph-cloud", path: "/aws", match: (p: string) => p.startsWith("/aws") },
  { label: "Security", short: "Security", icon: "ph-shield-warning", path: "/security", match: (p: string) => p.startsWith("/security") },
  { label: "Alarms", short: "Alarms", icon: "ph-bell", path: "/alarms", match: (p: string) => p.startsWith("/alarms") },
  { label: "Access", short: "Access", icon: "ph-key", path: "/access", match: (p: string) => p.startsWith("/access") },
  { label: "Vulnerabilities", short: "Vulns", icon: "ph-bug-beetle", path: "/dependencies", match: (p: string) => p.startsWith("/dependencies") },
  { label: "Repos", short: "Repos", icon: "ph-books", path: "/graph", match: (p: string) => p.startsWith("/graph") },
  { label: "PR's", short: "PR's", icon: "ph-git-pull-request", path: "/pulls", match: (p: string) => p.startsWith("/pulls") },
  { label: "Who knows", short: "Who", icon: "ph-users-three", path: "/who-knows", match: (p: string) => p.startsWith("/who-knows") },
  { label: "Activity", short: "Activity", icon: "ph-pulse", path: "/activity", match: (p: string) => p.startsWith("/activity") },
];

export default function Navbar({ login, avatarUrl }: NavbarProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: status } = useQuery({
    queryKey: ["auth", "status"],
    queryFn: fetchAuthStatus,
    staleTime: 60_000,
  });

  // Undefined while the status loads: show everything rather than flashing a
  // one-tab bar at every launch and then filling it in.
  const githubBlocked = status?.githubAccess?.allowed === false;
  const items = githubBlocked ? ITEMS.filter(i => ALWAYS_AVAILABLE.has(i.path)) : ITEMS;

  /**
   * Leave a tab the account you just switched into cannot serve.
   *
   * Hiding it from the bar is not enough when you are standing on it: the page
   * stays mounted, its queries 403, and it reads as the app breaking rather
   * than as the account not having that half. Only ever moves you off a tab
   * that has actually gone.
   */
  useEffect(() => {
    if (!githubBlocked) return;
    const stillOffered = ITEMS.some(i => ALWAYS_AVAILABLE.has(i.path) && i.match(pathname));
    if (!stillOffered) navigate("/aws", { replace: true });
  }, [githubBlocked, pathname, navigate]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const { theme, toggle } = useTheme();

  // Sign out used to be an unlabelled icon in the corner, which is the same as
  // not having one — nobody hovers a glyph to find out what it does.
  useEffect(() => {
    if (!accountOpen) return;
    const close = (e: MouseEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setAccountOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAccountOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [accountOpen]);

  const logout = async () => {
    const token = getToken();
    if (token) { try { await revokeGithub(token); } catch { /* best effort */ } }
    clearToken();
    if ((window as any).electronAPI?.clearGithubSession) {
      try { await (window as any).electronAPI.clearGithubSession(); } catch { /* best effort */ }
    }
    navigate("/login");
  };

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 h-16 z-40 bg-white dark:bg-[#11141c] border-b border-slate-200 dark:border-white/[0.08]">
        <div className="h-full max-w-[1600px] mx-auto px-4 sm:px-6 flex items-center gap-6">
          <button className="xl:hidden text-white/60 hover:text-white p-1 -ml-1" onClick={() => setMenuOpen(o => !o)}>
            <i className={`ph-bold ${menuOpen ? "ph-x" : "ph-list"} text-xl`}></i>
          </button>

          <button onClick={() => navigate("/")} className="flex items-center gap-2.5 shrink-0 group">
            <span className="w-8 h-8 rounded-xl bg-slate-900 dark:bg-white flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
              <i className="ph-fill ph-shield-check text-white dark:text-[#11141c] text-lg"></i>
            </span>
            <span className="hidden sm:block text-left leading-tight">
              <span className="block text-[13px] font-black text-slate-900 dark:text-white tracking-tight">Control Hub</span>
              <span className="block text-[10px] text-slate-400 dark:text-white/40 font-medium">{COMPANY_NAME}</span>
            </span>
          </button>

          <div className="hidden xl:flex items-center gap-0.5">
            {items.map(item => {
              const on = item.match(pathname);
              return (
                <button key={item.path} onClick={() => navigate(item.path)}
                  className={`px-3.5 py-2 rounded-xl text-[13px] font-bold transition-all flex items-center gap-2 ${
                    on
                      ? "bg-slate-900 dark:bg-white text-white dark:text-[#11141c]"
                      : "text-slate-500 dark:text-white/55 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.07]"}`}>
                  <i className={`${on ? "ph-fill" : "ph-bold"} ${item.icon} text-[15px]`}></i>
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <button onClick={toggle}
              className="w-9 h-9 rounded-xl text-slate-400 dark:text-white/50 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.07] flex items-center justify-center transition-colors"
              title={theme === "dark" ? "Switch to light" : "Switch to dark"}>
              <i className={`ph-bold ${theme === "dark" ? "ph-sun" : "ph-moon"} text-base`}></i>
            </button>
            {login && (
              <div ref={accountRef} className="relative pl-2 sm:pl-3 border-l border-slate-200 dark:border-white/10">
                <button
                  onClick={() => setAccountOpen(o => !o)}
                  aria-haspopup="menu"
                  aria-expanded={accountOpen}
                  className="flex items-center gap-2.5 pl-1 pr-2 py-1 rounded-xl hover:bg-slate-100 dark:hover:bg-white/[0.07] transition-colors"
                >
                  <UserAvatar login={login} avatarUrl={avatarUrl} size={28} className="ring-2 ring-slate-200 dark:ring-white/15" />
                  <span className="hidden md:block text-[13px] font-semibold text-slate-700 dark:text-white/80">{login}</span>
                  <i className={`ph-bold ph-caret-down text-[11px] text-slate-400 dark:text-white/40 transition-transform ${accountOpen ? "rotate-180" : ""}`}></i>
                </button>

                {accountOpen && (
                  <div role="menu"
                    className="absolute right-0 top-full mt-2 w-60 rounded-2xl bg-white dark:bg-[#151a23] border border-slate-200 dark:border-white/10 shadow-xl overflow-hidden animate-fade-in">
                    <div className="px-4 py-3 border-b border-slate-100 dark:border-white/[0.07]">
                      <p className="text-[10px] uppercase tracking-[0.16em] font-bold text-slate-400 dark:text-white/35">Signed in as</p>
                      <p className="text-sm font-bold text-slate-900 dark:text-white mt-1 truncate">{login}</p>
                      <p className="text-[11px] text-slate-400 dark:text-white/40 mt-0.5">{COMPANY_NAME}</p>
                    </div>
                    <AwsAccountSwitcher
                      current={status?.aws?.profile}
                      onSwitched={() => setAccountOpen(false)} />
                    <button role="menuitem" onClick={logout}
                      className="w-full px-4 py-3 flex items-center gap-2.5 text-[13px] font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors text-left border-t border-slate-100 dark:border-white/[0.07]">
                      <i className="ph-bold ph-sign-out text-base"></i>
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </nav>

      {menuOpen && (
        <div className="fixed inset-0 top-16 z-30 bg-white dark:bg-[#11141c] xl:hidden overflow-y-auto animate-fade-in">
          <div className="p-4 grid gap-1">
            {items.map(item => {
              const on = item.match(pathname);
              return (
                <button key={item.path}
                  onClick={() => { navigate(item.path); setMenuOpen(false); }}
                  className={`flex items-center gap-3 px-4 py-3.5 rounded-xl text-left font-bold transition-colors ${
                    on
                      ? "bg-slate-900 dark:bg-white text-white dark:text-[#11141c]"
                      : "text-slate-500 dark:text-white/60 hover:bg-slate-100 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white"}`}>
                  <i className={`${on ? "ph-fill" : "ph-bold"} ${item.icon} text-lg`}></i>
                  {item.label}
                </button>
              );
            })}

            {login && (
              <>
                <div className="h-px bg-slate-200 dark:bg-white/10 my-2" />
                <button
                  onClick={() => { setMenuOpen(false); logout(); }}
                  className="flex items-center gap-3 px-4 py-3.5 rounded-xl text-left font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors">
                  <i className="ph-bold ph-sign-out text-lg"></i>
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
