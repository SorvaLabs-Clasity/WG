import type { BranchRule, TagRule, PushRule } from "./Template";

export type RuleTemplateType = "classic" | "branch_ruleset" | "tag_ruleset" | "push_ruleset";

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  ruleType: RuleTemplateType;
  /** For classic / branch_ruleset types */
  branchProtection?: NonNullable<BranchRule["protection"]>;
  /** For tag_ruleset type */
  tagProtection?: Omit<TagRule, "tagPatterns">;
  /** For push_ruleset type */
  pushProtection?: PushRule;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
