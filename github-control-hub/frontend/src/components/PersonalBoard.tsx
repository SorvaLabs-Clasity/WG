import { useState } from "react";
import { WidgetFormModal, CheckDetail } from "../pages/AnalyticsPage";
import PersonalCard from "./PersonalCard";
import WidgetFilterEditor from "./WidgetFilterEditor";
import AlarmModal from "./AlarmModal";
import { useMyAlarms } from "../hooks/useAlarms";
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
  const [filtering, setFiltering] = useState<WidgetConfig | null>(null);
  const [alarming, setAlarming] = useState<WidgetConfig | null>(null);
  const { data: myAlarms } = useMyAlarms();

  if (isLoading) return <div className="py-16 flex justify-center"><Spinner /></div>;

  const list = widgets ?? [];

  // In place, the way the Overview does it, rather than a modal on top of a
  // grid. The detail is the same component, so the table, the verdict and the
  // freshness stamp cannot drift from the shared board's.
  /**
   * The modals, rendered from both branches.
   *
   * They used to sit only under the grid, below an early return for the detail
   * view — so pressing Add alarm from inside a card did nothing at all: the
   * state was set and the component that reads it was not on screen. Pressing
   * Edit afterwards left the detail view, which mounted both at once, so the
   * alarm dialog appeared on the wrong click and the edit form appeared behind
   * it. One place to declare them, reachable from wherever they were opened.
   */
  const modals = (
    <>
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
              //
              // Straight into the filters afterwards, because narrowing is the
              // reason most of these cards exist and the choices only become
              // real once the check has rows to offer.
              const made = await create.mutateAsync({ ...config, personal: true } as any);
              if (made) setFiltering(made);
            }
            setAdding(false);
            setEditing(null);
          }}
        />
      )}

      {filtering && (
        <WidgetFilterEditor config={filtering} onClose={() => setFiltering(null)} />
      )}

      {alarming && (
        <AlarmModal isOpen personal widgetId={alarming.id} onClose={() => setAlarming(null)} />
      )}
    </>
  );

  if (opened) {
    return (
      <>
      <CheckDetail
        config={opened}
        onBack={() => setOpened(null)}
        onEdit={() => { setEditing(opened); setOpened(null); }}
        canEdit
        // Offered here now. The reason it was not is that an alarm meant an
        // organization group and an administrator's permission, which is the
        // wrong shape for your own card. A personal alarm has neither: it goes
        // to the addresses on your own Alarms tab and nobody else is told.
        onAlarm={() => setAlarming(opened)}
        canAlarm
        alarmCount={(myAlarms ?? []).filter(a => a.widgetId === opened.id).length}
      />
      {modals}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-[12.5px] text-slate-500 dark:text-slate-400 max-w-[70ch]">
          Only you see these. They run the same checks as the Overview tab, and
          each card can be narrowed to the repositories, owners and values you
          care about.
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
          body="Add the checks you care about, the repositories you own, the vulnerabilities that reach you, a query you keep running by hand. Nobody else sees them, so nothing here needs to be worth everyone's attention."
          action={<Button variant="primary" onClick={() => setAdding(true)}>Add your first card</Button>}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map(w => (
            <PersonalCard
              key={w.id}
              config={w}
              onOpen={() => setOpened(w)}
              onEdit={() => setEditing(w)}
              onFilters={() => setFiltering(w)}
              onAlarm={() => setAlarming(w)}
              alarmCount={(myAlarms ?? []).filter(a => a.widgetId === w.id).length}
              onRemove={() => remove.mutate(w.id)}
            />
          ))}
        </div>
      )}

      {modals}
    </>
  );
}
