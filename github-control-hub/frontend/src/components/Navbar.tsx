import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import AwsAccountSwitcher from "./AwsAccountSwitcher";
import UserAvatar from "./UserAvatar";
import { useTheme } from "../hooks/useTheme";
import { revokeGithub } from "../api/auth";
import { clearToken, getToken } from "../api/client";
import { COMPANY_NAME } from "../design/tokens";
import ThemePicker from "./ThemePicker";
import { themeEntry, isRail, type Skin } from "../design/themes";
import { useQuery } from "@tanstack/react-query";
import { fetchAuthStatus } from "../api/auth";

interface NavbarProps {
  login?: string;
  avatarUrl?: string;
}

/**
 * The masthead.
 *
 * Two tiers, the way a broadsheet sets its front page: the title of the paper
 * over a heavy rule, and the section line under it. The current section is
 * inked and underlined rather than sitting in a filled pill — a printed page
 * marks where you are with weight, not with a shape.
 *
 * The edition line carries the things that are true of the whole app rather
 * than of any one screen: whose install this is, today's date, which edition is
 * running, and who is signed in.
 */

/**
 * Which sections survive when GitHub is confined to another AWS account.
 *
 * The backend refuses every GitHub route there, so a section left in the line
 * leads to a 403 that only explains itself after a page half-loads. Hiding them
 * is presentation; the refusal is the restriction.
 *
 * Activity stays and shows only the AWS rows: it is the one feed carrying both
 * halves, and an account running guardrails needs the record of what they did.
 * Alarms stays because guardrails can raise them, and that account needs
 * somewhere to see what is firing and who is told.
 */
const ALWAYS_AVAILABLE = new Set(["/aws", "/activity", "/alarms"]);

const ITEMS = [
  // First, because it is the one somebody opens without being sent there.
  { label: "My work", path: "/my-work", match: (p: string) => p.startsWith("/my-work") },
  { label: "Overview", path: "/analytics", match: (p: string) => p === "/" || p.startsWith("/analytics") },
  { label: "AWS", path: "/aws", match: (p: string) => p.startsWith("/aws") },
  { label: "Alarms", path: "/alarms", match: (p: string) => p.startsWith("/alarms") },
  { label: "Access", path: "/access", match: (p: string) => p.startsWith("/access") },
  { label: "Vulnerabilities", path: "/dependencies", match: (p: string) => p.startsWith("/dependencies") },
  { label: "Repos", path: "/graph", match: (p: string) => p.startsWith("/graph") },
  { label: "Pull requests", path: "/pulls", match: (p: string) => p.startsWith("/pulls") },
  { label: "Who knows", path: "/who-knows", match: (p: string) => p.startsWith("/who-knows") },
  { label: "Activity", path: "/activity", match: (p: string) => p.startsWith("/activity") },
];

/** The edition's date, set the way a paper dates itself. */
function today() {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

/**
 * The section line, opened out on a narrow window. Shared by both layouts.
 *
 * Declared out here rather than inside Navbar. A component defined in a render
 * body is a new function — so a new element type — on every render, and React
 * answers that by unmounting the old subtree and mounting a fresh one rather
 * than updating in place. repro-nestedcomponents.ts is the rule; the sheet
 * holds no state of its own, but the next thing added to it would have lost it
 * silently.
 */
function SectionSheet({ items, pathname, login, skin, onGo, onTheme, onSignOut }: {
  items: { label: string; path: string; match: (p: string) => boolean }[];
  pathname: string;
  login?: string;
  skin: Skin;
  onGo: (path: string) => void;
  onTheme: () => void;
  onSignOut: () => void;
}) {
  return (

  <div className="fixed inset-0 top-[5.75rem] z-30 bg-paper xl:hidden overflow-y-auto animate-[fadeIn_140ms_ease-out]">
    <div className="max-w-[100rem] mx-auto px-5 sm:px-8 py-3">
      {items.map(item => {
        const on = item.match(pathname);
        return (
          <button key={item.path}
            onClick={() => onGo(item.path)}
            className={`w-full flex items-baseline justify-between gap-4 py-3.5 border-b border-rule text-left transition-colors ${
              on ? "text-ink" : "text-ink-2 hover:text-ink"}`}>
            <span className={`display text-[1.125rem] ${on ? "text-ink" : ""}`}>{item.label}</span>
            {on && <span className="caps text-ink">Reading</span>}
          </button>
        );
      })}

      <button
        onClick={onTheme}
        className="w-full flex items-baseline justify-between gap-4 py-3.5 border-b border-rule text-left">
        <span className="display text-[1.125rem] text-ink">Appearance</span>
        <span className="caps">{themeEntry(skin).name}</span>
      </button>

      {login && (
        <button
          onClick={onSignOut}
          className="w-full py-4 text-left caps text-crimson">
          Sign out
        </button>
      )}
    </div>
  </div>
  );
}

/**
 * How the dismissal finds an open account menu.
 *
 * A marker rather than a ref, because the rail layout renders the menu twice —
 * once down the side for wide windows, once in the narrow-window bar — and a
 * single ref is claimed by whichever mounts last, which is the hidden one.
 * Every click in the *visible* menu then looked like a click outside one: the
 * handler closed it on mousedown, the button was gone before mouseup, and
 * React never dispatched the click. Appearance did nothing at all under
 * Cockpit. `closest()` asks the question that was actually meant — "is this
 * click inside *an* account menu" — and stays right however many copies a
 * layout renders.
 */
const ACCOUNT_MARK = "data-account-menu";

/**
 * The edition switch and the account menu, for either layout.
 *
 * A top-level component rather than JSX held in a variable, because the rail
 * layout renders it twice — once down the side, once in the narrow-window bar —
 * and the two need different things. Held as one shared element it also shared
 * a `ref`, which the second copy silently won: every click in the *visible*
 * menu then looked like a click outside one, so the menu closed on mousedown
 * and React never dispatched the click. That is why Appearance did nothing at
 * all under Cockpit.
 *
 * `placement` is the other half. A menu hanging off the foot of a side rail
 * opens upwards; the same menu in a bar pinned to the top of the window has to
 * open down, or it lands above the viewport and cannot be reached.
 */
function AccountMenu({
  placement, login, avatarUrl, theme, skin, appVersion, awsProfile,
  open, onToggleOpen, onClose, onToggleEdition, onTheme, onSignOut,
}: {
  placement: "up" | "down";
  login?: string;
  avatarUrl?: string;
  theme: "light" | "dark";
  skin: Skin;
  appVersion: string;
  awsProfile?: string;
  open: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  onToggleEdition: () => void;
  onTheme: () => void;
  onSignOut: () => void;
}) {
  return (
  <>
    <button onClick={onToggleEdition} className="textlink caps"
      title={theme === "dark" ? "Switch to the day edition" : "Switch to the night edition"}>
      {theme === "dark" ? "Day edition" : "Night edition"}
    </button>

    {login && (
      <div {...{ [ACCOUNT_MARK]: "" }} className="relative">
        <button
          onClick={() => onToggleOpen()}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-2.5 group"
        >
          <UserAvatar login={login} avatarUrl={avatarUrl} size={26}
            className="border border-rule-strong" />
          <span className="hidden md:block caps text-ink group-hover:text-ink-2 transition-colors">
            {login}
          </span>
          <span aria-hidden="true" className={`text-[0.5rem] text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
        </button>

        {open && (
          <div role="menu"
            className={`absolute w-72 bg-paper border border-ink animate-[fadeIn_140ms_ease-out] z-50 ${
              placement === "up" ? "left-0 bottom-full mb-3" : "right-0 top-full mt-3"}`}>
            <span className="block h-[3px] w-full bg-ink" aria-hidden="true" />
            <div className="px-5 py-4 border-b border-rule">
              <p className="caps">Signed in as</p>
              <p className="display text-[1.125rem] text-ink mt-1.5 truncate">{login}</p>
              <div className="dateline mt-2 text-[0.75rem]">
                <span>{COMPANY_NAME}</span>
                {appVersion && <span className="font-mono">v{appVersion}</span>}
              </div>
            </div>
            {/* Above the account switcher and sign-out, because it is the one
                item here somebody opens this menu *for* rather than reaches
                on the way out. */}
            <button role="menuitem"
              onClick={() => onTheme()}
              className="w-full px-5 py-3.5 flex items-baseline justify-between gap-4 text-left
                         hover:bg-ink/[0.05] transition-colors border-b border-rule">
              <span className="caps text-ink">Appearance</span>
              <span className="caps">{themeEntry(skin).name} · {theme === "dark" ? "Night" : "Day"}</span>
            </button>
            <AwsAccountSwitcher
              current={awsProfile}
              onSwitched={onClose} />
            <button role="menuitem" onClick={onSignOut}
              className="w-full px-5 py-3.5 text-left caps text-crimson hover:bg-crimson-wash transition-colors border-t border-rule">
              Sign out
            </button>
          </div>
        )}
      </div>
    )}
  </>
  );
}

export default function Navbar({ login, avatarUrl }: NavbarProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: status } = useQuery({
    queryKey: ["auth", "status"],
    queryFn: fetchAuthStatus,
    staleTime: 60_000,
  });

  // Undefined while the status loads: show everything rather than flashing a
  // one-section line at every launch and then filling it in.
  const githubBlocked = status?.githubAccess?.allowed === false;
  const items = githubBlocked ? ITEMS.filter(i => ALWAYS_AVAILABLE.has(i.path)) : ITEMS;

  /**
   * Leave a section the account you just switched into cannot serve.
   *
   * Hiding it from the line is not enough when you are standing on it: the page
   * stays mounted, its queries 403, and it reads as the app breaking rather
   * than as the account not having that half. Only ever moves you off a section
   * that has actually gone.
   */
  useEffect(() => {
    if (!githubBlocked) return;
    const stillOffered = ITEMS.some(i => ALWAYS_AVAILABLE.has(i.path) && i.match(pathname));
    if (!stillOffered) navigate("/aws", { replace: true });
  }, [githubBlocked, pathname, navigate]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const { theme, toggle, skin } = useTheme();

  // Sign out used to be an unlabelled icon in the corner, which is the same as
  // not having one. Nobody hovers a glyph to find out what it does.
  useEffect(() => {
    if (!accountOpen) return;
    const close = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest?.(`[${ACCOUNT_MARK}]`)) setAccountOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAccountOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [accountOpen]);

  /**
   * Which build this is.
   *
   * Worth a line on screen because the alternative is inspecting the installed
   * bundle. A fix can be committed, pushed, built and still not be in the app
   * you are running: a release whose version has not moved does not publish, so
   * the download stays the previous build and nothing says so.
   *
   * Empty in a browser, where there is no installed build to name.
   */
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    window.electronAPI?.getAppVersion?.()
      .then(setAppVersion)
      .catch(() => { /* a missing version is not worth a broken menu */ });
  }, []);

  const logout = async () => {
    const token = getToken();
    if (token) { try { await revokeGithub(token); } catch { /* best effort */ } }
    clearToken();
    if ((window as any).electronAPI?.clearGithubSession) {
      try { await (window as any).electronAPI.clearGithubSession(); } catch { /* best effort */ }
    }
    navigate("/login");
  };

  const rail = isRail(skin);

  /**
   * The account block and the edition switch, which both layouts need.
   *
   * Extracted rather than duplicated: they carry a dropdown, an outside-click
   * listener and a sign-out, and two copies of that is two places for the
   * behaviour to drift.
   */
  /**
   * The rail.
   *
   * Not a restyled masthead: a different tree. Sections run down the side as a
   * list, the current one takes a marginal bar rather than an underline, and
   * the account block sits at the foot where a sidebar puts it. This is the
   * one part of a theme CSS could not have decided on its own, and it is the
   * part that actually stops two themes looking like one.
   */
  if (rail) {
    return (
      <>
        <nav className="hidden xl:flex fixed left-0 top-0 bottom-0 z-40 flex-col
                        w-[var(--rail-w)] bg-paper-2 border-r border-rule">
          <button onClick={() => navigate("/")}
            className="px-4 py-4 text-left border-b border-rule shrink-0">
            <span className="display block text-[1.0625rem] leading-none text-ink">Control Hub</span>
            {COMPANY_NAME !== "Control Hub" && (
              <span className="caps block mt-1.5 truncate">{COMPANY_NAME}</span>
            )}
          </button>

          <div className="flex-1 overflow-y-auto py-2">
            {items.map(item => {
              const on = item.match(pathname);
              return (
                <button key={item.path} onClick={() => navigate(item.path)}
                  aria-current={on ? "page" : undefined}
                  className={`relative w-full text-left px-4 py-2 flex items-center transition-colors ${
                    on ? "bg-ink/[0.06] text-ink" : "hover:bg-ink/[0.035]"}`}>
                  {on && <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-ink" aria-hidden="true" />}
                  <span className={`caps ${on ? "text-ink" : ""}`}>{item.label}</span>
                </button>
              );
            })}
          </div>

          <div className="shrink-0 border-t border-rule px-4 py-3.5 flex flex-col items-start gap-3">
            <AccountMenu placement={"up"} login={login} avatarUrl={avatarUrl} theme={theme} skin={skin}
            appVersion={appVersion} awsProfile={status?.aws?.profile}
            open={accountOpen} onToggleOpen={() => setAccountOpen(o => !o)}
            onClose={() => setAccountOpen(false)}
            onToggleEdition={toggle}
            onTheme={() => { setAccountOpen(false); setThemeOpen(true); }}
            onSignOut={logout} />
          </div>
        </nav>

        {/* Below xl the rail is the whole screen, so every theme falls back to
            the same compact bar. */}
        <nav className="xl:hidden fixed top-0 left-0 right-0 h-[5.75rem] z-40 bg-paper border-b border-rule">
          <div className="h-full px-5 flex flex-col">
            <div className="flex-1 flex items-center justify-between gap-5">
              <button onClick={() => navigate("/")} className="display text-[1.5rem] leading-none text-ink">
                Control Hub
              </button>
              <div className="flex items-center gap-5"><AccountMenu placement={"down"} login={login} avatarUrl={avatarUrl} theme={theme} skin={skin}
            appVersion={appVersion} awsProfile={status?.aws?.profile}
            open={accountOpen} onToggleOpen={() => setAccountOpen(o => !o)}
            onClose={() => setAccountOpen(false)}
            onToggleEdition={toggle}
            onTheme={() => { setAccountOpen(false); setThemeOpen(true); }}
            onSignOut={logout} /></div>
            </div>
            <div className="border-t-2 border-ink" />
            <div className="h-10 flex items-stretch">
              <button className="caps flex items-center gap-2 text-ink"
                onClick={() => setMenuOpen(o => !o)} aria-expanded={menuOpen}>
                <span aria-hidden="true">{menuOpen ? "✕" : "☰"}</span>
                Sections
              </button>
            </div>
          </div>
        </nav>

        {menuOpen && (
          <SectionSheet
            items={items} pathname={pathname} login={login} skin={skin}
            onGo={(path) => { navigate(path); setMenuOpen(false); }}
            onTheme={() => { setMenuOpen(false); setThemeOpen(true); }}
            onSignOut={() => { setMenuOpen(false); logout(); }} />
        )}
        <ThemePicker open={themeOpen} onClose={() => setThemeOpen(false)} />
      </>
    );
  }

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 h-[5.75rem] z-40 bg-paper border-b border-rule">
        <div className="h-full max-w-[1600px] mx-auto px-5 sm:px-8 flex flex-col">

          {/* ── Tier one: the title of the paper ─────────────────────── */}
          <div className="flex-1 flex items-center justify-between gap-6 pb-1.5">
            <button onClick={() => navigate("/")} className="flex items-baseline gap-3 min-w-0 text-left group">
              <span className="display text-[1.5rem] sm:text-[1.7rem] leading-none text-ink tracking-[0.01em] whitespace-nowrap">
                Control Hub
              </span>
              {/* Only where it says something the wordmark does not. An
                  unbranded install sets COMPANY_NAME to the app's own name, and
                  printing it twice on one line reads as a mistake. */}
              {COMPANY_NAME !== "Control Hub" && (
                <span className="hidden sm:inline caps text-ink-3 group-hover:text-ink transition-colors truncate">
                  {COMPANY_NAME}
                </span>
              )}
            </button>

            <div className="flex items-center gap-5 shrink-0">
              <span className="hidden lg:block caps text-ink-4 whitespace-nowrap">{today()}</span>
              <AccountMenu placement={"down"} login={login} avatarUrl={avatarUrl} theme={theme} skin={skin}
            appVersion={appVersion} awsProfile={status?.aws?.profile}
            open={accountOpen} onToggleOpen={() => setAccountOpen(o => !o)}
            onClose={() => setAccountOpen(false)}
            onToggleEdition={toggle}
            onTheme={() => { setAccountOpen(false); setThemeOpen(true); }}
            onSignOut={logout} />
            </div>
          </div>

          {/* ── The heavy rule ───────────────────────────────────────── */}
          <div className="border-t-2 border-ink" />

          {/* ── Tier two: the section line ───────────────────────────── */}
          <div className="h-10 flex items-stretch">
            <div className="hidden xl:flex items-stretch gap-0 -mb-px overflow-x-auto">
              {items.map(item => {
                const on = item.match(pathname);
                return (
                  <button key={item.path} onClick={() => navigate(item.path)}
                    aria-current={on ? "page" : undefined}
                    className={`caps px-3.5 first:pl-0 flex items-center border-b-2 whitespace-nowrap transition-colors ${
                      on ? "text-ink border-ink" : "border-transparent hover:text-ink"}`}>
                    {item.label}
                  </button>
                );
              })}
            </div>

            <button className="xl:hidden caps flex items-center gap-2 text-ink"
              onClick={() => setMenuOpen(o => !o)} aria-expanded={menuOpen}>
              <span aria-hidden="true">{menuOpen ? "✕" : "☰"}</span>
              Sections
            </button>
          </div>
        </div>
      </nav>

      {menuOpen && (
          <SectionSheet
            items={items} pathname={pathname} login={login} skin={skin}
            onGo={(path) => { navigate(path); setMenuOpen(false); }}
            onTheme={() => { setMenuOpen(false); setThemeOpen(true); }}
            onSignOut={() => { setMenuOpen(false); logout(); }} />
        )}

      <ThemePicker open={themeOpen} onClose={() => setThemeOpen(false)} />
    </>
  );
}
