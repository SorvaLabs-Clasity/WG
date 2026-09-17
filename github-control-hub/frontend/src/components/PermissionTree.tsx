import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { TYPE } from "../design";
import type { PermissionLeaf, PermissionEntry, FlatRule } from "../api/admin";
import {
  buildTree, collectLeafKeys, knownNodesOf, decideLeaf, ownRulesFrom, baselineOf, collapseEntry,
  type Node,
} from "./permissionTreeModel";

/**
 * The permission tree.
 *
 * Renders whatever `vocabulary` it is handed — fetched from `/api/admin/vocabulary`
 * by the caller, never a copy kept here — as a collapsible tree grouped by the
 * dots in each key. `alarms.org.create` sits under `alarms.org` under `alarms`,
 * derived from the keys themselves so the grouping cannot disagree with the
 * vocabulary that drives it.
 *
 * This component owns one thing: **one layer of grant/revoke** (`entry`), which
 * it edits. Everything beneath that layer — a person's presets, a preset's
 * parent — arrives already flattened as `inherited`, ranked by `layer` exactly
 * the way `backend/src/permissions/evaluate.ts` ranks team, preset and person.
 * That is what lets a leaf's origin read "From preset Engineer" for something
 * this layer never touched, and "Granted here" / "Revoked here" for something
 * it did.
 *
 * **Every click writes the shortest entry that expresses the *difference*.**
 * `inherited` is the baseline; a leaf whose desired state already matches what
 * the layers beneath decide produces no rule at all, so a branch nobody touched
 * stays untouched and a team grant is never frozen into a person's own entry.
 * A branch whose whole subtree differs in the same direction still collapses to
 * one rule, which is what keeps a leaf added to the vocabulary later inside
 * that grant. The arithmetic lives in `./permissionTreeModel`, where it can be
 * run without React; this file is the rendering.
 */

function originText(decision: FlatRule | null, ownLayer: number): string {
  if (!decision) return "Not granted";
  if (decision.layer === ownLayer) return decision.effect === "grant" ? "Granted here" : "Revoked here";
  return decision.origin;
}

// ── the component ─────────────────────────────────────────────────────

export interface PermissionTreeProps {
  /** The vocabulary, fetched from the server. Never a client-side copy. */
  vocabulary: PermissionLeaf[];
  /**
   * Every rule from a layer beneath the one being edited, already flattened and
   * ranked — from `resolvePresetChain` in `../api/admin`, typically. Empty for a
   * preset with no parent.
   */
  inherited: FlatRule[];
  /**
   * What the layers beneath decide, leaf by leaf, as the server computed it.
   *
   * Optional, and derived from `inherited` when it is absent — which is only
   * correct because `decideLeaf` here is the server's `decideLeaf`. Where the
   * server can answer the question itself it should: the baseline is what every
   * edit is a difference from, so a client that reconstructs it is a client
   * that can quietly disagree with the evaluator the save will be judged by.
   */
  baseline?: ReadonlyMap<string, boolean>;
  /** The layer being edited. */
  entry: PermissionEntry;
  onChange: (entry: PermissionEntry) => void;
  readOnly?: boolean;
}

export default function PermissionTree({
  vocabulary, inherited, baseline: given, entry, onChange, readOnly,
}: PermissionTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const tree = useMemo(() => buildTree(vocabulary), [vocabulary]);

  const knownNodes = useMemo(() => knownNodesOf(vocabulary), [vocabulary]);

  /**
   * What the layers beneath this one decide on their own — the baseline every
   * edit is a difference from. Derived from `inherited` alone, never from the
   * resolved state, which is the distinction the whole of `collapseEntry`
   * turns on.
   */
  const baseline = useMemo(
    () => given ?? baselineOf(vocabulary, inherited, knownNodes),
    [given, vocabulary, inherited, knownNodes],
  );

  // One layer above the deepest inherited one, so a person's own entry always
  // outranks their presets at equal depth, the way `LAYER.person` outranks
  // `LAYER.preset` on the server.
  const ownLayer = useMemo(
    () => (inherited.length ? Math.max(...inherited.map(r => r.layer)) : 0) + 1,
    [inherited],
  );

  const allRules = useMemo(() => [...inherited, ...ownRulesFrom(entry, ownLayer)], [inherited, entry, ownLayer]);

  const decisions = useMemo(() => {
    const m = new Map<string, FlatRule | null>();
    for (const leaf of vocabulary) m.set(leaf.key, decideLeaf(leaf.key, allRules, knownNodes));
    return m;
  }, [vocabulary, allRules, knownNodes]);

  const held = useCallback((key: string) => decisions.get(key)?.effect === "grant", [decisions]);

  const toggleExpand = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const handleToggle = useCallback((node: Node) => {
    if (readOnly) return;
    const desired = new Map<string, boolean>();
    for (const leaf of vocabulary) desired.set(leaf.key, held(leaf.key));

    if (node.isLeaf) {
      desired.set(node.key, !held(node.key));
    } else {
      const leaves = collectLeafKeys(node);
      const count = leaves.filter(held).length;
      const next = count < leaves.length; // "some" or "none" -> grant all; "all" -> revoke all
      for (const key of leaves) desired.set(key, next);
    }

    onChange(collapseEntry(desired, tree, baseline));
  }, [readOnly, vocabulary, held, tree, baseline, onChange]);

  if (vocabulary.length === 0) {
    return <p className={`${TYPE.sub} text-ink-3`}>The vocabulary has not loaded yet.</p>;
  }

  return (
    <div className="border border-rule">
      {tree.map((node, i) => (
        <TreeRow key={node.key} node={node} depth={0} first={i === 0}
          expanded={expanded} onToggleExpand={toggleExpand}
          decisions={decisions} held={held} ownLayer={ownLayer}
          onToggle={handleToggle} readOnly={!!readOnly} />
      ))}
    </div>
  );
}

// ── rows ──────────────────────────────────────────────────────────────
//
// Declared at module scope, not inside `PermissionTree`: a component declared
// in a render body is a new function type on every render, and React unmounts
// and remounts it instead of updating in place (repro-nestedcomponents.ts).
// `TreeRow` recurses into itself for a branch's children, which is fine — it
// is still one top-level declaration, called with new props each time.

interface TreeRowProps {
  node: Node;
  depth: number;
  first: boolean;
  expanded: Set<string>;
  onToggleExpand: (key: string) => void;
  decisions: Map<string, FlatRule | null>;
  held: (key: string) => boolean;
  ownLayer: number;
  onToggle: (node: Node) => void;
  readOnly: boolean;
}

function TreeRow({ node, depth, first, expanded, onToggleExpand, decisions, held, ownLayer, onToggle, readOnly }: TreeRowProps) {
  const indent = { paddingLeft: `${0.9 + depth * 1.25}rem` };
  const border = first ? "" : "border-t border-rule";

  if (node.isLeaf) {
    const decision = decisions.get(node.key) ?? null;
    const isHeld = decision?.effect === "grant";
    return (
      <div className={`flex items-center justify-between gap-4 py-2 pr-4 ${border}`} style={indent}>
        <label className="flex items-center gap-2.5 min-w-0 cursor-pointer">
          <input type="checkbox" checked={isHeld} disabled={readOnly}
            onChange={() => onToggle(node)} className="shrink-0" />
          <span className={`${TYPE.body} text-ink truncate`}>{node.leaf?.label ?? node.label}</span>
        </label>
        <span className={`${TYPE.sub} text-ink-3 shrink-0 text-right`}>{originText(decision, ownLayer)}</span>
      </div>
    );
  }

  const leaves = collectLeafKeys(node);
  const count = leaves.filter(held).length;
  const state: "all" | "some" | "none" = count === 0 ? "none" : count === leaves.length ? "all" : "some";
  const isOpen = expanded.has(node.key);

  return (
    <div className={border}>
      <div className="flex items-center justify-between gap-4 py-2.5 pr-4 bg-paper-2" style={indent}>
        <div className="flex items-center gap-2.5 min-w-0">
          <TriCheckbox state={state} disabled={readOnly} onChange={() => onToggle(node)} />
          <button type="button" onClick={() => onToggleExpand(node.key)}
            className="flex items-center gap-2 min-w-0 text-left">
            <span aria-hidden="true" className={`text-[0.625rem] text-ink-3 transition-transform inline-block ${isOpen ? "rotate-90" : ""}`}>
              ▶
            </span>
            <span className="caps text-ink truncate">{node.label}</span>
          </button>
        </div>
        <span className={`${TYPE.sub} text-ink-3 tabular-nums shrink-0`}>{count} / {leaves.length}</span>
      </div>
      {isOpen && node.children.map((child, i) => (
        <TreeRow key={child.key} node={child} depth={depth + 1} first={i === 0}
          expanded={expanded} onToggleExpand={onToggleExpand}
          decisions={decisions} held={held} ownLayer={ownLayer}
          onToggle={onToggle} readOnly={readOnly} />
      ))}
    </div>
  );
}

/** A native checkbox with the third, indeterminate state — DOM-only, so a ref sets it. */
function TriCheckbox({ state, disabled, onChange }: {
  state: "all" | "some" | "none"; disabled?: boolean; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === "some"; }, [state]);
  return (
    <input ref={ref} type="checkbox" checked={state === "all"} disabled={disabled}
      onChange={onChange} className="shrink-0" />
  );
}
