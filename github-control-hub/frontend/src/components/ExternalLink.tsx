import type { ReactNode } from "react";

/**
 * A link that opens in the user's own browser, in the desktop app and in a tab.
 *
 * `target="_blank"` alone is not enough here. In Electron it depends on the main
 * process intercepting a window-open request, and that interception has a
 * branch — the one that keeps a sign-in inside the app window — which allows the
 * window instead of handing it to the browser. Whenever that branch is taken for
 * an ordinary link, the click does **nothing at all**: no navigation, no error,
 * no console message. It reads as the app being wrong about the link existing,
 * which is worse than an error.
 *
 * So the desktop path asks the main process directly, and the browser path is
 * the plain anchor it always was. `href` is kept in both, so the link still
 * shows its destination on hover, opens with a middle click, and can be copied.
 */
declare global {
  interface Window {
    electronAPI?: { openExternal?: (url: string) => Promise<boolean> };
  }
}

export default function ExternalLink({ href, className, title, children }: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const bridge = typeof window !== "undefined" ? window.electronAPI?.openExternal : undefined;

  return (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={bridge
        ? (e) => {
            // Only the plain left click is taken over. A middle click or a
            // modifier is somebody deliberately asking for a new tab or a copy,
            // and hijacking that would break the thing they expect.
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            void bridge(href);
          }
        : undefined}
    >
      {children}
    </a>
  );
}
