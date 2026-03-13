import { docClient, usesDynamo, tableName, PutCommand, GetCommand } from "../utils/dynamo";

export interface ComplianceRule {
  id: string;
  name: string;
  enabled: boolean;
  weight: number;
  type: "branch_protection" | "tag_protection" | "rulesets" | "required_files" | "outside_collaborators" | "query" | "codeowners";
  branchName?: string;
  tagPatterns?: string[];
  protectionType?: "any" | "classic" | "ruleset";
  rules?: {
    requirePr?: boolean;
    minApprovals?: number;
    dismissStaleReviews?: boolean;
    requireCodeOwnerReviews?: boolean;
    requireConversationResolution?: boolean;
    requireStatusChecks?: boolean;
    strictStatusChecks?: boolean;
    requireSignedCommits?: boolean;
    requireLinearHistory?: boolean;
    enforceAdmins?: boolean;
    preventForcePush?: boolean;
    preventDeletion?: boolean;
  };
  requiredFiles?: string[];
  maxOutsideCollaborators?: number;
  queryId?: string;
  queryParam?: string;
  queryAdvanced?: Record<string, unknown>;
  codeownersRequireEntries?: string[];
}

export interface ComplianceConfig {
  org: string;
  rules: ComplianceRule[];
}

const TABLE = () => tableName("ORG_CONFIG_TABLE");
const CONFIG_KEY = "compliance-config";

const DEFAULT_RULES: ComplianceRule[] = [
  {
    id: "default-branch-protection",
    name: "Branch Protection",
    enabled: true,
    weight: 35,
    type: "branch_protection",
    branchName: "__default__",
    protectionType: "any",
  },
  {
    id: "active-rulesets",
    name: "Active repository rulesets",
    enabled: true,
    weight: 25,
    type: "rulesets",
  },
  {
    id: "required-files",
    name: "Required files present",
    enabled: true,
    weight: 25,
    type: "required_files",
    requiredFiles: ["README.md"],
  },
  {
    id: "outside-collaborators",
    name: "Outside collaborator limit",
    enabled: true,
    weight: 15,
    type: "outside_collaborators",
    maxOutsideCollaborators: 0,
  },
];

let memConfig: ComplianceConfig | null = null;

function defaultConfig(): ComplianceConfig {
  return {
    org: CONFIG_KEY,
    rules: JSON.parse(JSON.stringify(DEFAULT_RULES)),
  };
}

export async function getComplianceConfig(): Promise<ComplianceConfig> {
  if (usesDynamo()) {
    const result = await docClient.send(
      new GetCommand({ TableName: TABLE(), Key: { org: CONFIG_KEY } })
    );
    if (result.Item) {
      return result.Item as ComplianceConfig;
    }
    const cfg = defaultConfig();
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: cfg }));
    return cfg;
  }
  if (!memConfig) {
    memConfig = defaultConfig();
  }
  return memConfig;
}

export async function updateComplianceConfig(rules: ComplianceRule[]): Promise<ComplianceConfig> {
  const cfg: ComplianceConfig = { org: CONFIG_KEY, rules };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: cfg }));
  } else {
    memConfig = cfg;
  }
  return cfg;
}
