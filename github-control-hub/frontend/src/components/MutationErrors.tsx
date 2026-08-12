import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { INTENT } from "../design";

/**
 * Shows the reason a write was refused.
 *
 * Every mutation in the app relied on its call site to report failures, and
 * most call sites did not — some awaited without a catch, which turns a
 * rejection into an unhandled promise and nothing on screen. A refusal then
 * looked exactly like a button that did nothing.
 *
 * That matters most for the ones the server is deliberate about: "only members
 * of X can edit templates", "you do not have permission to enable Dependabot
 * alerts on Y". Those sentences exist to be read.
 *
 * Subscribing to the mutation cache catches every one of them in a single
 * place, including mutations added later, which a per-hook onError would not.
 */
export default function MutationErrors() {
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<{ id: number; message: string }[]>([]);

  useEffect(() => {
    let nextId = 1;
    return queryClient.getMutationCache().subscribe(event => {
      if (event.type !== "updated" || event.action?.type !== "error") return;

      const message = (event.action.error as Error)?.message?.trim();
      // 401 and the org-membership 403 already redirect to /login; announcing
      // them here would flash a message on the way out.
      if (!message || message === "Unauthorized") return;

      const id = nextId++;
      setErrors(prev => (prev.some(e => e.message === message) ? prev : [...prev, { id, message }]));
      // Permission messages name a team and a repo and take a moment to read.
      setTimeout(() => setErrors(prev => prev.filter(e => e.id !== id)), 9000);
    });
  }, [queryClient]);

  if (errors.length === 0) return null;

  const tone = INTENT.danger;
  return (
    <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 max-w-[420px] pointer-events-none">
      {errors.map(e => (
        <div
          key={e.id}
          role="alert"
          className={`pointer-events-auto rounded-2xl border shadow-lg backdrop-blur p-4 flex items-start gap-3 ${tone.soft} ${tone.border}`}
          style={{ animation: "slideUp 0.3s cubic-bezier(0.16,1,0.3,1) both" }}
        >
          <i className={`ph-fill ph-warning-circle text-lg shrink-0 mt-0.5 ${tone.text}`}></i>
          <p className={`flex-1 text-[13px] leading-relaxed ${tone.text}`}>{e.message}</p>
          <button
            onClick={() => setErrors(prev => prev.filter(x => x.id !== e.id))}
            className={`shrink-0 opacity-50 hover:opacity-100 transition-opacity ${tone.text}`}
            aria-label="Dismiss"
          >
            <i className="ph-bold ph-x text-sm"></i>
          </button>
        </div>
      ))}
    </div>
  );
}
