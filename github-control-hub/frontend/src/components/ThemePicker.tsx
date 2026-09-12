import { useEffect } from "react";
import { useTheme } from "../hooks/useTheme";
import { THEMES, themeEntry, isRail, type Edition, type Skin } from "../design/themes";

/**
 * Choosing how the app is set.
 *
 * Every card is a *running copy* of its theme rather than a picture of one.
 * The theme system keys off two data attributes and a class, and nothing in it
 * requires those to be on the root element — so a preview is the real
 * vocabulary (masthead, rule, figure, record, stamp, text link) rendered inside
 * a div carrying another theme's attributes. It cannot drift from the thing it
 * is advertising, because it *is* the thing.
 *
 * The choice applies on click with no Save button. Seeing it is the whole point
 * of the screen, and a theme you have to commit to before you can look at it is
 * a theme nobody tries.
 */
export default function ThemePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { skin, setSkin, theme, toggle } = useTheme();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // Restored rather than cleared: something else may have set it, and
    // clearing would silently undo theirs.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  const chosen = themeEntry(skin);

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center p-4 sm:p-6"
      role="dialog" aria-modal="true" aria-label="Appearance">
      <div className="absolute inset-0 bg-ink/50 animate-[fadeIn_140ms_ease-out]"
        onClick={onClose} aria-hidden="true" />

      <div className="relative w-full max-w-[70rem] max-h-full overflow-y-auto bg-paper border border-ink
                      animate-[rise_200ms_cubic-bezier(0.22,1,0.36,1)]">
        <span className="block h-[3px] w-full bg-ink" aria-hidden="true" />

        <header className="px-6 sm:px-8 pt-6 pb-4 flex items-end justify-between gap-6 flex-wrap
                           border-b border-rule">
          <div className="min-w-0">
            <h2 className="display text-[clamp(1.625rem,3vw,2.125rem)] text-ink leading-tight">
              Appearance
            </h2>
            <p className="standfirst text-[0.875rem] mt-2 max-w-[62ch]">
              {THEMES.length} ways of setting the same application. Every screen is written once; the
              theme decides what a headline, a rule, a figure and a button look like — and, for some of
              them, where navigation lives and how dense the whole build is.
            </p>
          </div>

          <div className="flex items-end gap-6 shrink-0">
            {/* The edition, beside the themes rather than buried in the bar,
                because every one of them has both and the previews below are
                showing whichever is chosen here. */}
            <div>
              <p className="caps mb-1.5">Edition</p>
              <div className="inline-flex items-stretch border-b border-rule-strong">
                {(["light", "dark"] as Edition[]).map((e, i) => (
                  <button key={e} onClick={() => { if (theme !== e) toggle(); }}
                    aria-pressed={theme === e}
                    className={`caps px-3.5 py-2 -mb-px border-b-2 transition-colors ${
                      i > 0 ? "border-l border-l-rule" : ""} ${
                      theme === e ? "text-ink border-b-ink" : "border-b-transparent hover:text-ink"}`}>
                    {e === "light" ? "Day" : "Night"}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={onClose} className="textlink caps">Close</button>
          </div>
        </header>

        <div className="px-6 sm:px-8 py-7">
          <div className="theme-grid grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {THEMES.map((t, i) => {
              const on = t.id === skin;
              return (
                <button key={t.id} onClick={() => setSkin(t.id)} aria-pressed={on}
                  style={{ animation: `rise 0.4s cubic-bezier(0.22,1,0.36,1) ${i * 45}ms backwards` }}
                  className={`group text-left border transition-colors ${
                    on ? "border-ink" : "border-rule hover:border-rule-strong"}`}>
                  <span className={`block h-[3px] w-full ${on ? "bg-ink" : "bg-transparent"}`}
                    aria-hidden="true" />

                  <Specimen skin={t.id} edition={theme} />

                  <div className="px-4 py-3.5 border-t border-rule">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="display text-[1.1875rem] text-ink">{t.name}</span>
                      {on
                        ? <span className="caps text-ink">In use</span>
                        : <span className="caps opacity-0 group-hover:opacity-100 transition-opacity">Use this</span>}
                    </div>
                    <p className="standfirst text-[0.7812rem] mt-1.5">{t.blurb}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* The long description, for the one actually chosen. Five of these on
              screen at once is five paragraphs nobody reads. */}
          <div className="mt-7 pt-4 border-t-2 border-ink">
            <p className="caps">{chosen.name}</p>
            <p className="standfirst text-[0.875rem] mt-2 max-w-[86ch]">{chosen.detail}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One theme, running, at about a tenth of the size.
 *
 * Deliberately shows the six things that differ most between themes and that a
 * swatch cannot carry: the masthead rule, the section line, the state rule, a
 * figure, a record with its marginal bar, and the pairing of a stamp with a
 * text link. `pointer-events-none` because the card around it is the control.
 */
function Specimen({ skin, edition }: { skin: Skin; edition: Edition }) {
  const rail = isRail(skin);
  return (
    <div
      data-skin={skin}
      data-edition={edition}
      className={`${edition === "dark" ? "dark" : ""} pointer-events-none select-none
                  bg-paper text-ink overflow-hidden`}
      /* Two things, both of which the card would otherwise lie about.
         `--page-image` is the ground Terminal and Blueprint rule into a grid,
         and it is set on the body, which a specimen never touches. And the
         font-size is the theme's own root: everything inside is sized in `em`
         rather than `rem` precisely so that a 13.5px theme and a 17.5px theme
         advertise themselves at the densities they actually run at. `rem`
         would have resolved against the page and shown all eight identically. */
      style={{
        backgroundImage: "var(--page-image)",
        backgroundSize: "24px 24px",
        fontSize: "var(--root-size)",
      }}
      aria-hidden="true"
    >
      <div className={rail ? "flex min-h-[11.5em]" : ""}>
        {/* Navigation is the one part a theme changes in kind rather than in
            degree, so the specimen has to render the tree, not restyle it. */}
        {rail ? (
          <div className="w-[5.5em] shrink-0 bg-paper-2 border-r border-rule py-[0.7em]">
            <div className="px-[0.8em] pb-[0.6em] border-b border-rule">
              <span className="display block text-[0.72em] leading-none text-ink">Control Hub</span>
            </div>
            {["Overview", "AWS", "Access", "Alarms"].map((n, i) => (
              <div key={n} className={`relative px-[0.8em] py-[0.34em] ${i === 0 ? "bg-ink/[0.06]" : ""}`}>
                {i === 0 && <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-ink" />}
                <span className={`caps caps-tight ${i === 0 ? "text-ink" : ""}`}>{n}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="absolute" />
        )}

        <div className="min-w-0 flex-1">
          {!rail && (
            <>
              <div className="px-[0.9em] pt-[0.8em] pb-[0.4em] flex items-baseline justify-between gap-2 border-b-2 border-ink">
                <span className="display text-[0.95em] text-ink leading-none">Control Hub</span>
                <span className="caps caps-tight">{edition === "dark" ? "Night" : "Day"}</span>
              </div>
              <div className="px-[0.9em] py-[0.4em] flex gap-[0.8em] border-b border-rule">
                <span className="caps caps-tight text-ink">Overview</span>
                <span className="caps caps-tight">AWS</span>
                <span className="caps caps-tight">Access</span>
              </div>
            </>
          )}

          <div className="px-[0.9em] pt-[0.8em] pb-[0.9em]">
            <div className="h-[2px] w-full bg-crimson" />
            <div className="pt-[0.6em] flex items-end">
              <div className="pr-[1em]">
                <p className="caps caps-tight">Affected</p>
                <p className="figure text-[1.7em] text-crimson mt-[0.2em]">930</p>
              </div>
              <div className="px-[1em] border-l border-rule">
                <p className="caps caps-tight">Clear</p>
                <p className="figure text-[1.7em] text-forest mt-[0.2em]">1</p>
              </div>
            </div>

            <div className="mt-[0.8em] relative border border-rule bg-paper">
              <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-ochre" aria-hidden="true" />
              <div className="pl-[0.9em] pr-[0.6em] py-[0.5em]">
                <p className="display text-[0.85em] text-ink leading-snug">Protection removed</p>
                <p className="standfirst text-[0.7em] mt-[0.25em]">web-platform · 30m ago</p>
              </div>
            </div>

            <div className="mt-[0.9em] flex items-center gap-[1em]">
              <span className="stamp stamp-sm">Add check</span>
              <span className="textlink">Refresh</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
