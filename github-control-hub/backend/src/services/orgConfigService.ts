import { docClient, hasTable, tableName, PutCommand, GetCommand, DeleteCommand } from "../utils/dynamo";

export interface OrgFeatures {
  rulesetsSupported: boolean;
  advancedSecurity: boolean;
}

export interface OrgConfig {
  org: string;
  features: OrgFeatures;
  /**
   * The account self-hosted Renovate raises pull requests as.
   *
   * Configuration rather than a constant: there is no Renovate API to ask, so
   * authorship is the only marker, and every installation names its bot
   * differently. Unset means the organization does not run Renovate, and the
   * tab says so instead of showing an empty table that looks like a failure.
   */
  renovateBot?: string;
  /**
   * The one Power Automate flow every Teams message goes through.
   *
   * Set once, by an administrator. A flow per person is ten steps in a tool
   * they do not otherwise use, with one silent failure mode if a dropdown is
   * wrong. This one is a pipe: it reads who the message is for out of the
   * request, so it serves everybody.
   *
   * Unset means Teams delivery is off, and every screen that offers it says so
   * rather than accepting an address that would go nowhere.
   */
  teamsFlow?: {
    url: string;
    setBy: string;
    setAt: string;
  };
  /**
   * When the access graph was last rebuilt, and how it went.
   *
   * Kept here rather than beside the edges because the aggregator clears that
   * table before rewriting it, a marker stored there would be deleted by the
   * next run, including a run that then failed, leaving no record at all.
   *
   * The screens that read the graph are showing a snapshot. Without this they
   * had no way to say how old it was, so a graph last built before someone
   * joined, left, or was made an owner looked exactly like a current one.
   */
  graphAggregation?: {
    /** Completion of the last run that actually wrote edges. */
    lastSuccessAt?: string;
    /** Start of the last run, successful or not. */
    lastAttemptAt?: string;
    /** Set when the last attempt failed, so the UI can say so rather than just looking stale. */
    lastError?: string;
    edgeCount?: number;
    /**
     * Set while a walk is under way, cleared when it ends.
     *
     * Shared, which is the point: the desktop app and the nightly Lambda write
     * the same row, so everybody's button says "recrawling" while anybody's
     * walk runs. As local component state it vanished on a tab switch and was
     * invisible to everyone else.
     *
     * Not authoritative on its own: a process that disappears never clears it,
     * so readers age it out. See RUN_ASSUMED_DEAD_MS in recrawlWindow.ts.
     */
    runningSince?: string;
    /** Who started the running walk: a login, or SCHEDULE_ACTOR. */
    startedBy?: string;
  };
  /**
   * Pull requests fetched per GraphQL page, learned rather than configured.
   *
   * The query's cost scales with the page, and the size an organization can
   * afford is a property of that organization, how many pull requests, how many
   * reviewers, how much CI. It is discovered by asking for a large page and
   * stepping down when GitHub gives up, which costs about eleven seconds per
   * step because that is how long GitHub takes to abandon a page it cannot
   * compute.
   *
   * Held in memory alone, that discovery ran once per process, so every launch
   * of the desktop app paid twenty to thirty seconds on the first load of the
   * pull request tab, and every Lambda cold start paid it again. Stored here, it
   * is paid once per organization, ever.
   */
  prPageSize?: number;
  /**
   * When a webhook delivery last arrived, whatever it turned out to contain.
   *
   * Silence is this feature's only failure mode: a broken webhook looks exactly
   * like a quiet week, and there is no backfill, so anything that happened
   * meanwhile is gone rather than late.
   *
   * Written on arrival rather than inferred from the activity feed. Most
   * delivered events write no feed row at all, since team, membership, member
   * and dependabot_alert only patch the graph, and the newest rows fill with
   * the app's own `sync.*` housekeeping.
   */
  lastWebhookAt?: string;
  /**
   * Detailed GitHub logging: whether the webhook worker also records the
   * routine traffic (branches, tags, pushes, pull requests) in the activity
   * feed, and which of those kinds are switched off individually.
   *
   * Collection only. Rows already written are never touched by this setting:
   * turning it off stops new detailed rows and deletes nothing, so the feed
   * keeps showing what was collected while it was on.
   */
  detailedLogging?: {
    enabled: boolean;
    /** Kind ids from DETAILED_LOG_KINDS the admin has unchecked. */
    disabledKinds?: string[];
    changedAt?: string;
    changedBy?: string;
  };
}

const TABLE = () => tableName("ORG_CONFIG_TABLE");

/**
 * The row this deployment's configuration lives in.
 *
 * A constant, and deliberately not the GitHub organization's name.
 *
 * There is one configuration per table and the table is per deployment, so the
 * name bought nothing and cost two things. In an install with no GitHub there
 * is no name, and DynamoDB refuses an empty string as a key attribute, so every
 * read threw. And a process that is kept away from GitHub on purpose, like the
 * guardrail function, has no way to know the name even where one exists: it
 * read the empty key too, which is why a guardrail alarm could send its email
 * and never its Teams message. The flow URL lives in this row.
 */
const CONFIG_KEY = "config";

/**
 * The row this deployment used to live in, when there is one.
 *
 * Reads fall back to it so an existing install keeps its Teams flow, its
 * Renovate bot and its rebuild history. Every writer here reads the whole row
 * and puts the whole row back, so the first write of any kind moves it, and
 * nothing has to be migrated by hand.
 */
const legacyKey = () => process.env.GITHUB_ORG || "";

// In-memory fallback for local development
let memConfig: OrgConfig = {
  org: "config",
  features: {
    rulesetsSupported: true,
    advancedSecurity: false,
  }
};

export async function getOrgConfig(): Promise<OrgConfig> {
  if (hasTable("ORG_CONFIG_TABLE")) {
    const result = await docClient.send(
      new GetCommand({ TableName: TABLE(), Key: { org: CONFIG_KEY } }));
    if (result.Item) return result.Item as OrgConfig;

    /**
     * Written before the key stopped being the organization's name.
     *
     * Migrated, not merely read through. Returning it under the new key was
     * enough for this process, and left two rows in the table: the next write
     * from here copies everything to `config` while the old row stays exactly
     * as it was. Nothing then keeps them in step, and anything still reading
     * the old key, a Lambda built before the change and not redeployed since,
     * carries on answering from a row that stopped being updated.
     *
     * That is the worst shape a split like this can take, because both halves
     * work. The app reads its row and is right; the deployed function reads its
     * row and is also right, about an organization as it was configured months
     * ago. A Teams flow URL set from the app after the change is simply not
     * there as far as that function is concerned, and the notification it
     * gates is skipped without a word.
     *
     * So the read that finds the old row is the one that fixes it: copy it
     * forward and delete it, and every reader converges on one row from then
     * on. The delete is allowed to fail; a copy that succeeded is already the
     * whole of the fix, and a second attempt costs one request.
     */
    const legacy = legacyKey();
    if (legacy && legacy !== CONFIG_KEY) {
      const old = await docClient.send(
        new GetCommand({ TableName: TABLE(), Key: { org: legacy } }));
      if (old.Item) {
        const moved = { ...(old.Item as OrgConfig), org: CONFIG_KEY };
        await docClient.send(new PutCommand({ TableName: TABLE(), Item: moved }));
        try {
          await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { org: legacy } }));
          console.log(`[OrgConfig] Migrated the organization row from "${legacy}" to "${CONFIG_KEY}".`);
        } catch (err: any) {
          console.warn(`[OrgConfig] Copied the organization row forward but could not remove `
            + `"${legacy}": ${err?.message ?? err}`);
        }
        return moved;
      }
    }

    // First access: seed default config
    const defaultConfig: OrgConfig = {
      org: CONFIG_KEY,
      features: { rulesetsSupported: true, advancedSecurity: false },
    };
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: defaultConfig }));
    return defaultConfig;
  }
  return memConfig;
}

export async function setTeamsFlow(url: string | null, actor: string): Promise<OrgConfig> {
  const current = await getOrgConfig();
  const updated: OrgConfig = {
    ...current,
    teamsFlow: url ? { url, setBy: actor, setAt: new Date().toISOString() } : undefined,
  };
  if (hasTable("ORG_CONFIG_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memConfig = updated;
  }
  return updated;
}

export async function updateRenovateBot(bot: string): Promise<OrgConfig> {
  const current = await getOrgConfig();
  const updated: OrgConfig = { ...current, renovateBot: bot.trim() || undefined };
  if (hasTable("ORG_CONFIG_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memConfig = updated;
  }
  return updated;
}

/**
 * Records how the access graph rebuild went.
 *
 * Merged onto whatever is stored rather than replacing it, so recording a
 * failed attempt does not erase the timestamp of the last good one, "last
 * built four hours ago, last attempt failed ten minutes ago" is the state
 * somebody needs to see, and either field alone hides half of it.
 */
export async function recordGraphAggregation(
  update: Partial<NonNullable<OrgConfig["graphAggregation"]>>,
): Promise<OrgConfig> {
  const current = await getOrgConfig();
  const updated: OrgConfig = {
    ...current,
    graphAggregation: { ...current.graphAggregation, ...update },
  };
  if (hasTable("ORG_CONFIG_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memConfig = updated;
  }
  return updated;
}

/** Remembers the page size that worked, so it is discovered once and not per process. */
export async function savePrPageSize(size: number): Promise<void> {
  const current = await getOrgConfig();
  if (current.prPageSize === size) return;
  const updated: OrgConfig = { ...current, prPageSize: size };
  if (hasTable("ORG_CONFIG_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memConfig = updated;
  }
}

export async function updateOrgFeatures(featureUpdates: Partial<OrgFeatures>): Promise<OrgConfig> {
  const current = await getOrgConfig();
  const updated: OrgConfig = {
    ...current,
    features: {
      ...current.features,
      ...featureUpdates,
    },
  };

  if (hasTable("ORG_CONFIG_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memConfig = updated;
  }

  return updated;
}

export interface DetailedLoggingSettings {
  enabled: boolean;
  disabledKinds: string[];
  changedAt?: string;
  changedBy?: string;
}

/** Never null: absent means the feature has not been turned on yet. */
export async function getDetailedLogging(): Promise<DetailedLoggingSettings> {
  const config = await getOrgConfig();
  return {
    enabled: config.detailedLogging?.enabled ?? false,
    disabledKinds: config.detailedLogging?.disabledKinds ?? [],
    changedAt: config.detailedLogging?.changedAt,
    changedBy: config.detailedLogging?.changedBy,
  };
}

export async function updateDetailedLogging(
  update: { enabled: boolean; disabledKinds: string[]; changedBy: string },
): Promise<DetailedLoggingSettings> {
  const current = await getOrgConfig();
  const updated: OrgConfig = {
    ...current,
    detailedLogging: {
      enabled: update.enabled,
      disabledKinds: update.disabledKinds,
      changedAt: new Date().toISOString(),
      changedBy: update.changedBy,
    },
  };
  if (hasTable("ORG_CONFIG_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memConfig = updated;
  }
  return getDetailedLogging();
}

/**
 * Note that a delivery arrived. Throttled, because this runs per delivery.
 *
 * At most one write every five minutes. The stamp is only read to answer "is
 * GitHub still reaching us", where five minutes of imprecision changes no
 * answer, and a write per delivery would be a DynamoDB write per webhook for a
 * field nothing else reads.
 *
 * The throttle lives in module scope, so a warm Lambda container skips the
 * write and a cold one pays for exactly one.
 */
let lastWebhookWriteAt = 0;
const WEBHOOK_STAMP_THROTTLE_MS = 5 * 60_000;

/** Test seam: forget the throttle so the next call writes. */
export function __resetWebhookStampThrottle(): void {
  lastWebhookWriteAt = 0;
}

export async function recordWebhookSeen(at?: string): Promise<void> {
  const now = Date.now();
  if (now - lastWebhookWriteAt < WEBHOOK_STAMP_THROTTLE_MS) return;
  lastWebhookWriteAt = now;

  const current = await getOrgConfig();
  const updated: OrgConfig = { ...current, lastWebhookAt: at || new Date().toISOString() };
  if (hasTable("ORG_CONFIG_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memConfig = updated;
  }
}
