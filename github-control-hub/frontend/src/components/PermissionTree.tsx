import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { TYPE } from "../design";
import type { PermissionLeaf, PermissionEntry, FlatRule } from "../api/admin";

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
 * **Every click writes the shortest entry that expresses the result.** Ticking
 * a leaf never appends one more string to a list that only grows; it recomputes
 * the whole layer from the tree's structure, so a branch whose every leaf ends
 * up granted collapses to one rule (`grant: ["alarms"]`) rather than thirteen —
 * which is also what keeps a leaf added to the vocabulary later inside the
 * grant, instead of silently outside it.
 */

// ── the tree, derived from the vocabulary's own keys ────────────────────

interface Node {
  key: string;
  label: string;
  isLeaf: boolean;
  leaf?: PermissionLeaf;
  children: Node[];
}

/** "webhookHealth" -> "Webhook health". Branches have no label of their own to show. */
function prettyLabel(segment: string): string {
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function buildTree(vocabulary: readonly PermissionLeaf[]): Node[] {
  const roots: Node[] = [];
  const branches = new Map<string, Node>();

  function ensureBranch(key: string): Node {
    const existing = branches.get(key);
    if (existing) return existing;
    const parts = key.split(".");
    const node: Node = { key, label: prettyLabel(parts[parts.length - 1]), isLeaf: false, children: [] };
    branches.set(key, node);
    if (parts.length === 1) roots.push(node);
    else ensureBranch(parts.slice(0, -1).join(".")).children.push(node);
    return node;
  }

  for (const leaf of vocabulary) {
    const parts = leaf.key.split(".");
    const leafNode: Node = { key: leaf.key, label: leaf.label, isLeaf: true, leaf, children: [] };
    if (parts.length === 1) roots.push(leafNode);
    else ensureBranch(parts.slice(0, -1).join(".")).children.push(leafNode);
  }
  return roots;
}

function collectLeafKeys(node: Node, out: string[] = []): string[] {
  if (node.isLeaf) { out.push(node.key); return out; }
  for (const child of node.children) collectLeafKeys(child, out);
  return out;
}

// ── deciding a leaf across layers, the same way the server does ─────────

const depthOf = (node: string) => node.split(".").length;

/** The longest, highest-layer match wins; a tie goes to revoke. Same order as `decideLeaf` server-side. */
function decideLeaf(leafKey: string, rules: FlatRule[], knownNodes: ReadonlySet<string>): FlatRule | null {
  let best: FlatRule | null = null;
  for (const rule of rules) {
    if (!knownNodes.has(rule.node)) continue;
    if (!(leafKey === rule.node || leafKey.startsWith(rule.node + "."))) continue;
    if (!best) { best = rule; continue; }
    const a = [depthOf(rule.node), rule.layer, rule.effect === "revoke" ? 1 : 0];
    const b = [depthOf(best.node), best.layer, best.effect === "revoke" ? 1 : 0];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] > b[i]) best = rule;
      break;
    }
  }
  return best;
}

function ownRulesFrom(entry: PermissionEntry, layer: number): FlatRule[] {
  return [
    ...(entry.grant ?? []).map(node => ({ node, effect: "grant" as const, layer, origin: "Granted here" })),
    ...(entry.revoke ?? []).map(node => ({ node, effect: "revoke" as const, layer, origin: "Revoked here" })),
  ];
}

function originText(decision: FlatRule | null, ownLayer: number): string {
  if (!decision) return "Not granted";
  if (decision.layer === ownLayer) return decision.effect === "grant" ? "Granted here" : "Revoked here";
  return decision.origin;
}

/**
 * The minimal `{grant, revoke}` that reproduces `desired` for every leaf in the
 * tree. Post-order: a node whose whole subtree wants the same thing collapses
 * to one rule and its children write nothing; a node that disagrees with
 * itself pushes a rule for each child that *is* uniform and leaves the rest to
 * recurse, which is how a mixed `alarms` still collapses `alarms.org` alone.
 */
function collapseEntry(desired: ReadonlyMap<string, boolean>, roots: Node[]): PermissionEntry {
  const grant: string[] = [];
  const revoke: string[] = [];

  function visit(node: Node): boolean | null {
    if (node.isLeaf) return desired.get(node.key) ?? false;
    if (node.children.length === 0) return null;
    const values = node.children.map(visit);
    const uniform = values[0] !== null && values.every(v => v === values[0]);
    if (uniform) return values[0];
    node.children.forEach((child, i) => {
      const v = values[i];
      if (v !== null) (v ? grant : revoke).push(child.key);
    });
    return null;
  }

  for (const root of roots) {
    const v = visit(root);
    if (v !== null) (v ? grant : revoke).push(root.key);
  }

  return { grant: grant.length ? grant : undefined, revoke: revoke.length ? revoke : undefined };
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
  /** The layer being edited. */
  entry: PermissionEntry;
  onChange: (entry: PermissionEntry) => void;
  readOnly?: boolean;
}

export default function PermissionTree({ vocabulary, inherited, entry, onChange, readOnly }: PermissionTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const tree = useMemo(() => buildTree(vocabulary), [vocabulary]);

  const knownNodes = useMemo(() => {
    const out = new Set<string>();
    for (const leaf of vocabulary) {
      out.add(leaf.key);
      const parts = leaf.key.split(".");
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."));
    }
    return out;
  }, [vocabulary]);

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

    onChange(collapseEntry(desired, tree));
  }, [readOnly, vocabulary, held, tree, onChange]);

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
