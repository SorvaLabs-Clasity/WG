import { AwsExclusionList, ResourceSnapshot } from "./types";

export interface ExclusionResult {
  excluded: boolean;
  /** Which list and which clause matched, for the findings table. */
  reason?: string;
}

/**
 * Whether a resource is excluded from a rule.
 *
 * Mirrors the GitHub exclusion semantics: explicit entries and patterns exclude,
 * and a whitelist entry wins over both so a single resource can be pulled back
 * in without unpicking a pattern.
 */
export function isExcluded(resource: ResourceSnapshot, lists: AwsExclusionList[]): ExclusionResult {
  for (const list of lists) {
    // Whitelist is checked first and short-circuits the whole list.
    if (list.whitelist?.some(w => w === resource.id)) continue;

    if (list.resources?.includes(resource.id)) {
      return { excluded: true, reason: `${list.name}: listed explicitly` };
    }

    for (const p of list.patterns ?? []) {
      if (matches(resource, p.type, p.value)) {
        return { excluded: true, reason: `${list.name}: ${p.type} "${p.value}"` };
      }
    }
  }
  return { excluded: false };
}

function matches(resource: ResourceSnapshot, type: string, value: string): boolean {
  switch (type) {
    case "starts_with":
      return resource.id.startsWith(value);
    case "contains":
      return resource.id.includes(value);
    case "tag_equals": {
      // "Key=Value"; a bare "Key" matches the tag being present at all.
      const idx = value.indexOf("=");
      if (idx === -1) return resource.tags[value] !== undefined;
      const key = value.slice(0, idx);
      const want = value.slice(idx + 1);
      return resource.tags[key] === want;
    }
    default:
      return false;
  }
}
