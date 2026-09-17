import type { PermissionsFile, Preset, PermissionEntry } from "./types";
import { presetProblems } from "./presets";
import { isKnownNodeNow } from "./accountScope";

/**
 * Whether a parsed file may be used, and what is wrong with it when it may not.
 *
 * Stage 1's engine assumes a well-formed file — `resolvePreset` returns the
 * rules it gathered below a missing ancestor rather than refusing, which grants
 * a subset where the spec wants nothing. This is the gate that makes that
 * assumption safe, so **nothing may evaluate a file that has not passed here.**
 *
 * The line between fatal and tolerated is the judgement that matters:
 *
 *   - **Fatal** is anything that makes the file mean something *other* than
 *     what it says: a dangling `inherits`, a cycle, a person assigned a preset
 *     that does not exist. Evaluating those silently produces a different
 *     answer from the one written down, and a permissions file that quietly
 *     means something else is worse than no file.
 *   - **Tolerated** is anything that merely names something this version of the
 *     app no longer has. An upgrade that removes a permission must not lock the
 *     organization out of the screen that would put it back, so unknown nodes
 *     are ignored at evaluation time and reported by `unknownNodesIn` for the
 *     admin screen to offer to clean up.
 */

export interface FileProblem {
  /** Where in the file: `presets.engineer`, `people.someone`. */
  where: string;
  what: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether a table really names this id, rather than inheriting it.
 *
 * `presets["toString"]` is a function on any `JSON.parse`d object, so the
 * dangling-preset check below read a preset that does not exist as one that
 * does, and let an entry assigned to it through as valid. See the same note in
 * `changeClasses.ts` and `presets.ts`.
 */
const has = (table: object, id: string): boolean => Object.hasOwn(table, id);

/** `grant` and `revoke` from one entry, whatever shape it arrived in. */
function nodesOf(entry: unknown): string[] {
  if (!isObject(entry)) return [];
  const out: string[] = [];
  for (const key of ["grant", "revoke"] as const) {
    const list = entry[key];
    if (Array.isArray(list)) out.push(...list.filter(v => typeof v === "string"));
  }
  return out;
}

export function fileProblems(raw: unknown): FileProblem[] {
  const problems: FileProblem[] = [];

  if (!isObject(raw)) {
    return [{ where: "file", what: "is not an object" }];
  }
  if (typeof raw.version !== "number") {
    problems.push({ where: "file", what: "has no numeric version" });
  }

  // Absent sections are an empty file, which is valid and grants nothing.
  // Refusing them would make the very first save impossible.
  for (const section of ["presets", "teams", "people"] as const) {
    if (raw[section] !== undefined && !isObject(raw[section])) {
      problems.push({ where: section, what: "is not an object" });
    }
  }
  if (problems.length > 0) return problems;

  const presets = (isObject(raw.presets) ? raw.presets : {}) as Record<string, Preset>;
  const teams = (isObject(raw.teams) ? raw.teams : {}) as Record<string, PermissionEntry & { presets?: string[] }>;
  const people = (isObject(raw.people) ? raw.people : {}) as Record<string, PermissionEntry & { presets?: string[] }>;

  // Filtered to entries that are actually objects, and never the caller's
  // `presets` itself: `presetProblems` (and, through it, `resolvePreset`) is
  // stage 1's code, written to assume a well-formed map. Handing it a `null`
  // or a string in place of a preset is exactly the kind of hand-edited
  // mistake this validator exists to catch — and must not throw doing so,
  // since a throw here is a fail-*open* path for `store.ts`, which treats it
  // differently from an ordinary rejection.
  const objectPresets: Record<string, Preset> = {};
  for (const [id, preset] of Object.entries(presets)) {
    if (!isObject(preset)) {
      problems.push({ where: `presets.${id}`, what: "is not an object" });
      continue;
    }
    objectPresets[id] = preset as unknown as Preset;
    if (typeof preset.name !== "string" || preset.name.length === 0) {
      problems.push({ where: `presets.${id}`, what: "has no name" });
    }
  }

  // Cycles, over-deep chains and dangling parents, from stage 1's own checker
  // rather than a second implementation that could disagree with it.
  for (const message of presetProblems(objectPresets)) {
    // A nameless preset is already reported above, at the more specific
    // `presets.<id>`. `presetProblems` reports the same defect again at the
    // coarser `presets`, because it has no per-id location to report at; kept
    // rather than removed from `presets.ts` since stage 1's own suite may
    // depend on it, and suppressed here instead so the file's owner sees one
    // problem, not two, for one mistake.
    if (/ has no name$/.test(message)) continue;
    problems.push({ where: "presets", what: message });
  }

  for (const [label, table] of [["people", people], ["teams", teams]] as const) {
    for (const [key, entry] of Object.entries(table)) {
      /**
       * `collectRules` looks a person up by `login.toLowerCase()`, so an entry
       * filed under `ANA` is never consulted — and a **revoke** written there
       * silently does nothing while reading as though it had taken effect.
       * `AdminPage.tsx` lower-cases before writing, so the screen is safe; a
       * hand-edited file or a direct API call is not, and this is the gate
       * that makes evaluation safe for both.
       */
      if (label === "people" && key !== key.toLowerCase()) {
        problems.push({
          where: `${label}.${key}`,
          what: `is not lower-case, so it is never consulted; write it as "${key.toLowerCase()}"`,
        });
        continue;
      }
      if (!isObject(entry)) {
        problems.push({ where: `${label}.${key}`, what: "is not an object" });
        continue;
      }
      // `isObject` narrows to Record<string, unknown>, so `presets` is
      // `unknown` here rather than a list. Checked rather than asserted: this
      // runs on a file somebody may have hand-edited.
      //
      // A `presets` that is present but not an array (a string, say, from a
      // hand-edit that dropped the brackets) must be reported, not treated as
      // "no presets assigned" — that reading makes the entry look unused
      // rather than broken, and silently grants nothing where the file asked
      // for something.
      if (entry.presets !== undefined && !Array.isArray(entry.presets)) {
        problems.push({ where: `${label}.${key}`, what: `has a "presets" that is not an array` });
        continue;
      }
      const assigned = entry.presets ?? [];
      for (const id of assigned) {
        if (typeof id !== "string" || !has(presets, id)) {
          problems.push({ where: `${label}.${key}`, what: `is assigned preset "${String(id)}", which does not exist` });
        }
      }
    }
  }

  return problems;
}

/** A file that may be evaluated. */
export function isUsable(raw: unknown): raw is PermissionsFile {
  return fileProblems(raw).length === 0;
}

/**
 * Nodes named anywhere in the file that this version of the app does not have.
 *
 * Not fatal, by design — see the note at the top. Reported so the admin screen
 * can say "unknown, ignored" rather than leaving somebody to wonder why a
 * permission they can see written down does nothing.
 */
export function unknownNodesIn(file: PermissionsFile): string[] {
  const seen = new Set<string>();
  const consider = (entry: unknown) => {
    for (const node of nodesOf(entry)) {
      if (!isKnownNodeNow(node)) seen.add(node);
    }
  };
  for (const preset of Object.values(file.presets ?? {})) consider(preset);
  for (const team of Object.values(file.teams ?? {})) consider(team);
  for (const person of Object.values(file.people ?? {})) consider(person);
  return [...seen];
}
