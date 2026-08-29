import { useState } from "react";
import { CheckCard, WidgetFormModal } from "../pages/AnalyticsPage";
import { useWidgets, useCreateWidget, useUpdateWidget, useDeleteWidget } from "../hooks/useWidgets";
import { Button, Empty, Spinner, Note } from "../design";
import type { WidgetConfig } from "../api/widgets";

/**
 * A dashboard somebody builds for themselves.
 *
 * The same engine as the Overview tab, pointed at one person. That reuse is the
 * whole idea: the checks, the presets, the insight queries and the verdicts all
 * exist and are tested, and the only thing missing was the ability to put a few
 * of them somewhere that is yours.
 *
 * It also settles a question the four fixed views could not. Which four things
 * belong on a developer's dashboard is not a question with one answer, and
 * guessing produces a screen that is nearly right for everybody. This lets
 * people stop asking for a fifth.
 *
 * The admin gate on the shared board does not apply here, and that is
 * deliberate rather than an oversight: the gate exists because the Overview is
 * one board seen by everybody, which is not what this is.
 */
export default function PersonalBoard() {
  const { data: widgets, isLoading } = useWidgets("personal");
  const create = useCreateWidget();
  const update = useUpdateWidget();
  const remove = useDeleteWidget();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WidgetConfig | null>(null);
  const [opened, setOpened] = useState<WidgetConfig | null>(null);

  if (isLoading) return <div className="py-16 flex justify-center"><Spinner /></div>;

  const list = widgets ?? [];

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
          Only you see these. They use the same checks as the Overview tab.
        </p>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <i className="ph-bold ph-plus mr-1.5 text-[12px]"></i>Add a card
        </Button>
      </div>

      {create.isError && (
        <div className="mb-4"><Note intent="danger">{(create.error as Error)?.message}</Note></div>
      )}

      {list.length === 0 ? (
        <Empty
          title="Nothing here yet"
          body="Add the checks you care about — the repositories you own, the vulnerabilities that reach you, a query you keep running by hand. Nobody else sees them, so nothing here needs to be worth everyone's attention."
          action={<Button variant="primary" onClick={() => setAdding(true)}>Add your first card</Button>}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((w, i) => (
            <CheckCard
              key={w.id}
              config={w}
              index={i}
              onOpen={() => setOpened(w)}
              // The shared board rolls its cards' verdicts into a page-level
              // headline. There is no such headline here, so nothing is
              // reported upwards and this is the required no-op rather than a
              // second aggregation nobody reads.
              onReport={() => { /* no page-level roll-up on a personal board */ }}
              canEdit
              onEdit={() => setEditing(w)}
              onRemove={() => remove.mutate(w.id)}
            />
          ))}
        </div>
      )}

      {(adding || editing) && (
        <WidgetFormModal
          initialData={editing ?? undefined}
          isSaving={create.isPending || update.isPending}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSave={async config => {
            if (editing) {
              await update.mutateAsync({ id: editing.id, data: config });
            } else {
              // `personal` is what puts it on this board. The server takes the
              // owner from the session rather than from here, so this cannot be
              // used to add a card to somebody else's page.
              await create.mutateAsync({ ...config, personal: true } as any);
            }
            setAdding(false);
            setEditing(null);
          }}
        />
      )}

      {opened && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setOpened(null)} />
          <div className="relative z-10 w-full max-w-3xl max-h-[85vh] overflow-auto rounded-2xl
                          bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">{opened.title}</h3>
              <button onClick={() => setOpened(null)}
                className="text-slate-400 hover:text-slate-900 dark:hover:text-white">
                <i className="ph ph-x text-lg"></i>
              </button>
            </div>
            <p className="text-[13px] text-slate-500 dark:text-slate-400">
              Open the Overview tab to see the full table for this check.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
