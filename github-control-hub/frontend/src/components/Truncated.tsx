import { useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Text that is clipped to its column, and readable in full on hover.
 *
 * Two things make this more than a `title` attribute.
 *
 * It only appears when the text is **actually** clipped, compared at the moment
 * of hovering rather than guessed from a character count. A cap like "over 40
 * characters" is wrong in both directions: it hides the end of an address that
 * would have fitted a wide column, and lets a shorter one overflow a narrow
 * one. The browser already knows, so it is asked.
 *
 * And it renders into `document.body`. The card it sits in has rounded corners
 * and therefore `overflow: hidden`, which clips an absolutely positioned bubble
 * to the row it belongs to, which is the one place it must not be.
 */
export default function Truncated({ text, className = "" }: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    const el = ref.current;
    if (!el) return;
    // Not clipped, so there is nothing a bubble could add.
    if (el.scrollWidth <= el.clientWidth) return;
    const r = el.getBoundingClientRect();
    setAt({ left: r.left, top: r.bottom + 6 });
  };

  return (
    <>
      <span
        ref={ref}
        className={`min-w-0 flex-1 truncate ${className}`}
        onMouseEnter={show}
        onMouseLeave={() => setAt(null)}
        // Keyboard users get it too, and it is why this is not a CSS-only
        // :hover rule.
        tabIndex={0}
        onFocus={show}
        onBlur={() => setAt(null)}
      >
        {text}
      </span>

      {at && createPortal(
        <div
          role="tooltip"
          style={{
            position: "fixed", left: at.left, top: at.top,
            // Clamped so a bubble opened near the right edge stays on screen.
            maxWidth: `calc(100vw - ${at.left + 16}px)`,
          }}
          className="z-[300] pointer-events-none px-2.5 py-1.5
                     text-[12px] leading-snug break-all bg-ink text-reverse"
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
