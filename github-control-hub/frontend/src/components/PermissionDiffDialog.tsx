import { useState, useMemo } from "react";
import { TYPE, SURFACE, Button } from "../design";
import type { AccountDiff } from "./permissionDiff";

/**
 * What will change, read the way a diff is read.
 *
 * The summary under the Save button answers "is this roughly right". This
 * answers "what exactly am I about to do to this person" — which is the
 * question somebody asks before changing what a colleague can do in
 * production, and the one a count of gains and losses cannot answer.
 *
 * Grouped by account, one account at a time, because the changes are per
 * account and a single flat list would put a production change and a sandbox
 * change next to each other with nothing but a label between them.
 */
export default function PermissionDiffDialog({
  title, subtitle, diffs, onCancel, onConfirm, confirming,
}: {
  title: string;
  subtitle?: string;
  diffs: AccountDiff[];
  onCancel: () => void;
  onConfirm: () => void;
  confirming?: boolean;
}) {
  const changed = useMemo(() => diffs.filter(d => !d.unchanged), [diffs]);
  const [at, setAt] = useState(0);
  const current = changed[Math.min(at, Math.max(0, changed.length - 1))];

  const totals = useMemo(() => ({
    gained: changed.reduce((n, d) => n + d.gained.length, 0),
    lost: changed.reduce((n, d) => n + d.lost.length, 0),
  }), [changed]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      role="dialog" aria-modal="true" aria-label={title}>
      <div className={`${SURFACE.sheet} w-full max-w-3xl max-h-[85vh] flex flex-col`}>
        <div className="px-5 py-4 border-b border-rule">
          <h2 className="display text-[1.25rem] text-ink">{title}</h2>
          {subtitle && <p className={`${TYPE.sub} text-ink-3 mt-0.5`}>{subtitle}</p>}
          <p className={`${TYPE.sub} text-ink-2 mt-2`}>
            {changed.length === 0
              ? "Nothing would change."
              : <>
                  <span className="text-forest">+{totals.gained}</span>
                  {" "}
                  <span className="text-crimson">−{totals.lost}</span>
                  {" across "}
                  {changed.length} {changed.length === 1 ? "account" : "accounts"}
                </>}
          </p>
        </div>

        {changed.length > 1 && (
          <div className="px-5 py-2 border-b border-rule flex items-center gap-2 flex-wrap">
            {changed.map((d, i) => (
              <button key={d.accountId}
                onClick={() => setAt(i)}
                className={`caps px-2 py-1 border ${i === at
                  ? "border-ink text-ink"
                  : "border-rule text-ink-3 hover:text-ink-2"}`}>
                {d.name}
                <span className="ml-1.5 text-forest">+{d.gained.length}</span>
                <span className="ml-1 text-crimson">−{d.lost.length}</span>
              </button>
            ))}
          </div>
        )}

        <div className="overflow-y-auto flex-1 px-5 py-4">
          {!current ? (
            <p className={`${TYPE.body} text-ink-3`}>
              The permissions are the same as the ones already saved.
            </p>
          ) : (
            <>
              {changed.length > 1 && (
                <p className={`${TYPE.sub} text-ink-3 mb-3`}>
                  {current.name} — account {at + 1} of {changed.length}
                </p>
              )}

              {/*
                * `+` and `−` lines rather than a two-column table: the change
                * is a set of permissions arriving and leaving, and a line per
                * permission is what makes a long list skimmable and a short
                * one unambiguous.
                */}
              <div className="font-mono text-[0.8125rem] leading-relaxed">
                {current.gained.map(l => (
                  <div key={`+${l.key}`} className="flex gap-2 px-2 py-0.5 bg-forest-wash text-forest">
                    <span aria-hidden="true">+</span>
                    <span className="sr-only">Gains</span>
                    <span className="min-w-0">{l.label}<span className="opacity-60"> · {l.key}</span></span>
                  </div>
                ))}
                {current.lost.map(l => (
                  <div key={`-${l.key}`} className="flex gap-2 px-2 py-0.5 bg-crimson-wash text-crimson">
                    <span aria-hidden="true">−</span>
                    <span className="sr-only">Loses</span>
                    <span className="min-w-0">{l.label}<span className="opacity-60"> · {l.key}</span></span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-rule flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            {changed.length > 1 && (
              <>
                <Button variant="ghost" disabled={at === 0} onClick={() => setAt(n => n - 1)}>
                  Previous account
                </Button>
                <Button variant="ghost" disabled={at >= changed.length - 1}
                  onClick={() => setAt(n => n + 1)}>
                  Next account
                </Button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" disabled={confirming || changed.length === 0}
              onClick={onConfirm}>
              {confirming ? "Saving…" : "Save these changes"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
