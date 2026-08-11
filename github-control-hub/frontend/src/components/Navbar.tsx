import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import UserAvatar from "./UserAvatar";
import { useTheme } from "../hooks/useTheme";
import { revokeGithub } from "../api/auth";
import { clearToken, getToken } from "../api/client";

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
const ITEMS = [
  { label: "Overview", short: "Overview", icon: "ph-chart-line-up", path: "/analytics", match: (p: string) => p === "/" || p.startsWith("/analytics") },
  { label: "Templates", short: "Templates", icon: "ph-stack", path: "/templates", match: (p: string) => p.startsWith("/templates") },
  { label: "AWS", short: "AWS", icon: "ph-cloud", path: "/aws", match: (p: string) => p.startsWith("/aws") },
  { label: "Security", short: "Security", icon: "ph-shield-warning", path: "/security", match: (p: string) => p.startsWith("/security") },
  { label: "Dependabot", short: "Deps", icon: "ph-bug-beetle", path: "/dependencies", match: (p: string) => p.startsWith("/dependencies") },
  { label: "Repos", short: "Repos", icon: "ph-books", path: "/graph", match: (p: string) => p.startsWith("/graph") },
  { label: "Activity", short: "Activity", icon: "ph-pulse", path: "/activity", match: (p: string) => p.startsWith("/activity") },
];

export default function Navbar({ login, avatarUrl }: NavbarProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { theme, toggle } = useTheme();

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
              <span className="block text-[10px] text-slate-400 dark:text-white/40 font-medium">Sorva Studios</span>
            </span>
          </button>

          <div className="hidden xl:flex items-center gap-0.5">
            {ITEMS.map(item => {
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
              <div className="flex items-center gap-2.5 pl-2 sm:pl-3 border-l border-slate-200 dark:border-white/10">
                <UserAvatar login={login} avatarUrl={avatarUrl} size={28} className="ring-2 ring-slate-200 dark:ring-white/15" />
                <span className="hidden md:block text-[13px] font-semibold text-slate-700 dark:text-white/80">{login}</span>
                <button onClick={logout} title="Sign out"
                  className="w-9 h-9 rounded-xl text-slate-400 dark:text-white/40 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.07] flex items-center justify-center transition-colors">
                  <i className="ph-bold ph-sign-out text-base"></i>
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {menuOpen && (
        <div className="fixed inset-0 top-16 z-30 bg-white dark:bg-[#11141c] xl:hidden overflow-y-auto animate-fade-in">
          <div className="p-4 grid gap-1">
            {ITEMS.map(item => {
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
          </div>
        </div>
      )}
    </>
  );
}
