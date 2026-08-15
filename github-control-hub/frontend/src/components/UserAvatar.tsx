import { useState } from "react";

interface UserAvatarProps {
  login: string;
  avatarUrl?: string;
  size?: number;
  className?: string;
}

function getInitials(login: string): string {
  const parts = login.split(/[-_.]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return login.slice(0, 2).toUpperCase();
}

const BG_COLORS = [
  "bg-blue-500", "bg-green-500", "bg-purple-500", "bg-orange-500",
  "bg-pink-500", "bg-teal-500", "bg-indigo-500", "bg-rose-500",
];

function colorForLogin(login: string): string {
  let hash = 0;
  for (let i = 0; i < login.length; i++) hash = login.charCodeAt(i) + ((hash << 5) - hash);
  return BG_COLORS[Math.abs(hash) % BG_COLORS.length];
}

/**
 * Names that stand for "no person", which must never be looked up on GitHub.
 *
 * `https://github.com/<login>.png` resolves for any account that exists, and
 * `unknown` is a real GitHub user — so every row with no attributable actor was
 * showing a stranger's photograph, on an audit screen, next to changes they had
 * nothing to do with. `github[system]` is what this app now records for audit
 * events GitHub raises itself; the rest are older placeholders still in the feed.
 */
const PLACEHOLDER_LOGINS = new Set([
  "unknown", "github[system]", "system", "github", "none", "n/a", "-",
]);

function isPlaceholder(login: string): boolean {
  return !login.trim() || PLACEHOLDER_LOGINS.has(login.trim().toLowerCase());
}

export default function UserAvatar({ login, avatarUrl, size = 24, className = "" }: UserAvatarProps) {
  const [failed, setFailed] = useState(false);

  const placeholder = isPlaceholder(login);
  const src = avatarUrl || `https://github.com/${login}.png?size=${size * 2}`;
  const initials = getInitials(login);
  const bgColor = colorForLogin(login);

  const sizeStyle = { width: size, height: size, minWidth: size, minHeight: size };
  const fontSize = Math.max(8, Math.round(size * 0.4));

  // A neutral mark, not initials: "UN" for unknown reads as somebody's actual
  // initials, which is the same wrong claim in smaller letters.
  if (placeholder && !avatarUrl) {
    return (
      <div
        className={`rounded-full flex items-center justify-center shrink-0 bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 ${className}`}
        style={{ ...sizeStyle, fontSize: Math.max(9, Math.round(size * 0.55)) }}
        title="No individual account is recorded for this event"
      >
        <i className="fa-solid fa-gear" aria-hidden="true"></i>
      </div>
    );
  }

  if (failed) {
    return (
      <div
        className={`rounded-full flex items-center justify-center text-white font-bold select-none shrink-0 ${bgColor} ${className}`}
        style={{ ...sizeStyle, fontSize }}
        title={login}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={login}
      className={`rounded-full object-cover shrink-0 ${className}`}
      style={sizeStyle}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
    />
  );
}
