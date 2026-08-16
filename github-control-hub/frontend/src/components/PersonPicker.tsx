import { useState, useRef, useEffect, useMemo } from "react";
import UserAvatar from "./UserAvatar";
import type { OrgMember } from "../api/org";

/**
 * Choose a person from the organization. Typing narrows; it never submits.
 *
 * A plain text box is the thing this replaces. It accepts any string, and a
 * great many strings are real GitHub accounts belonging to strangers — so a
 * mistyped name does not fail, it silently names somebody outside the
 * organization and renders their photograph next to it. Nothing about that
 * looks wrong, and the person who was meant to stop being reminded keeps being
 * reminded.
 *
 * So there is no free-text path out of this component. `onPick` is only ever
 * called with a login that came from the list.
 */
export default function PersonPicker({
  members, loading, exclude = [], onPick, placeholder = "Search people…", disabled,
}: {
  members: OrgMember[];
  loading?: boolean;
  /** Already chosen, so they are shown as unavailable rather than offered again. */
  exclude?: string[];
  onPick: (login: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const taken = useMemo(
    () => new Set(exclude.map(l => l.trim().toLowerCase())),
    [exclude],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = members.filter(m => !taken.has(m.login.trim().toLowerCase()));
    if (!q) return pool.slice(0, 50);
    // A name that starts with what was typed is what was meant; one that merely
    // contains it is a fallback. Ranking otherwise buries the obvious answer.
    const starts = pool.filter(m => m.login.toLowerCase().startsWith(q));
    const has = pool.filter(m => !m.login.toLowerCase().startsWith(q) && m.login.toLowerCase().includes(q));
    return [...starts, ...has].slice(0, 50);
  }, [members, query, taken]);

  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // Keeps the highlighted row on screen when arrowing past the visible window.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const take = (login: string) => {
    onPick(login);
    setQuery("");
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setCursor(c => {
        const n = matches.length;
        if (n === 0) return 0;
        return e.key === "ArrowDown" ? (c + 1) % n : (c - 1 + n) % n;
      });
      return;
    }
    if (e.key === "Enter") {
      // Never submits what was typed. Enter with nothing highlighted does
      // nothing, which is the correct amount to do with a name that is not on
      // the list.
      e.preventDefault();
      const hit = matches[cursor];
      if (hit) take(hit.login);
      return;
    }
    if (e.key === "Escape") { setOpen(false); }
  };

  const q = query.trim();

  return (
    <div ref={box} className="relative">
      <div className="relative">
        <i className="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none"></i>
        <input
          value={query}
          disabled={disabled}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder={placeholder}
          role="combobox" aria-expanded={open} aria-autocomplete="list"
          className="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 rounded-lg text-slate-700 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-gh-blue/40 focus:border-gh-blue disabled:opacity-50"
        />
      </div>

      {open && !disabled && (
        <div ref={listRef}
          className="absolute z-20 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1a202b] shadow-xl p-1">
          {loading ? (
            <p className="px-3 py-2 text-[13px] text-slate-400 dark:text-slate-500">Loading people…</p>
          ) : matches.length === 0 ? (
            // Says which of the two it is. "Not in this organization" and
            // "already muted" send you to different next actions, and a single
            // "no results" line makes them look like the same dead end.
            <p className="px-3 py-2 text-[13px] text-slate-500 dark:text-slate-400">
              {q
                ? taken.has(q.toLowerCase())
                  ? <><strong className="font-semibold">{q}</strong> is already on the list.</>
                  : <>Nobody in this organization matches <strong className="font-semibold">{q}</strong>.</>
                : "Nobody left to choose."}
            </p>
          ) : matches.map((m, i) => (
            <button key={m.login} type="button"
              data-active={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => take(m.login)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2.5 transition-colors ${
                i === cursor ? "bg-gh-blue text-white" : "text-slate-700 dark:text-slate-200"}`}>
              {/* The real avatar from the members list, not one guessed from a
                  string — a guessed URL resolves for any GitHub account at all,
                  which is how a stranger's face ended up in this box. */}
              <UserAvatar login={m.login} avatarUrl={m.avatarUrl ?? undefined} size={22} />
              <span className="text-[13px] font-medium truncate">{m.login}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
