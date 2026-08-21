import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ColumnWidths, mergeWidths, widthsToStore, widthAfterDrag, storageKey,
} from "../lib/columnWidths";

/**
 * Column widths a person can drag, remembered per table.
 *
 * The state is here and the arithmetic is in `lib/columnWidths`, so the part
 * worth testing can be tested without rendering anything.
 *
 * Pointer events rather than mouse events, so a drag works with a trackpad, a
 * stylus and a touchscreen from one code path. `setPointerCapture` is what
 * makes a drag survive the pointer leaving the handle — without it, moving
 * faster than React re-renders drops the drag, which feels like the handle
 * "sticking" every few pixels.
 */
export function useColumnWidths(tableId: string, defaults: ColumnWidths) {
  const [widths, setWidths] = useState<ColumnWidths>(() => defaults);
  const [dragging, setDragging] = useState<string | null>(null);

  // Keyed by the columns on screen, so a widget whose shape changed re-reads
  // rather than keeping a layout for columns it no longer has.
  const defaultsKey = Object.keys(defaults).sort().join("|");

  useEffect(() => {
    let stored: unknown = null;
    try {
      const raw = localStorage.getItem(storageKey(tableId));
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      // Unreadable or unparseable: the defaults are a perfectly good answer.
    }
    setWidths(mergeWidths(defaults, stored));
    // defaults is rebuilt every render; defaultsKey is the part that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, defaultsKey]);

  const persist = useCallback((next: ColumnWidths) => {
    try {
      const diff = widthsToStore(defaults, next);
      if (Object.keys(diff).length === 0) localStorage.removeItem(storageKey(tableId));
      else localStorage.setItem(storageKey(tableId), JSON.stringify(diff));
    } catch {
      // Private mode, or a full quota. A layout that is not remembered is a
      // much smaller problem than a table that throws while you resize it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, defaultsKey]);

  /** Everything one drag needs, captured when it starts rather than read live. */
  const drag = useRef<{ id: string; startX: number; startWidth: number } | null>(null);

  const onResizeStart = useCallback((columnId: string, event: React.PointerEvent) => {
    // Left button only, and never let the click reach the header's sort handler.
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture?.(event.pointerId);

    drag.current = {
      id: columnId,
      startX: event.clientX,
      startWidth: widths[columnId] ?? defaults[columnId],
    };
    setDragging(columnId);
  }, [widths, defaults]);

  const onResizeMove = useCallback((event: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = widthAfterDrag(d.startWidth, event.clientX - d.startX);
    setWidths(prev => (prev[d.id] === next ? prev : { ...prev, [d.id]: next }));
  }, []);

  const onResizeEnd = useCallback((event: React.PointerEvent) => {
    if (!drag.current) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    drag.current = null;
    setDragging(null);
    // Read from state rather than the ref: the last move may not have committed.
    setWidths(current => { persist(current); return current; });
  }, [persist]);

  /** Double-click a handle to put that one column back. */
  const resetColumn = useCallback((columnId: string) => {
    setWidths(prev => {
      const next = { ...prev, [columnId]: defaults[columnId] };
      persist(next);
      return next;
    });
  }, [defaults, persist]);

  const resetAll = useCallback(() => {
    setWidths(defaults);
    try { localStorage.removeItem(storageKey(tableId)); } catch { /* see persist */ }
  }, [defaults, tableId]);

  /** Whether anything has been dragged, so a "reset" control can hide itself. */
  const customised = Object.keys(widthsToStore(defaults, widths)).length > 0;

  return {
    widths, dragging, customised,
    onResizeStart, onResizeMove, onResizeEnd, resetColumn, resetAll,
  };
}
