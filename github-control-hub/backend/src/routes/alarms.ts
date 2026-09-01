import { Router, Request, Response, RequestHandler } from "express";

import {
  isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM,
  isAwsAdmin, AWS_ADMIN_TEAM,
} from "../services/authorizationService";
import { getWidget } from "../services/widgetService";
import {
  listAlarms, listOrgAlarms, listOrgGroups, getAlarm, createAlarm, updateAlarm, deleteAlarm,
  listGroups, getGroup, saveGroup, createGroupRecord, deleteGroupRecord, alarmsUsingGroup,
  getSecuritySettings, saveSecuritySettings,
  getFeedSettings, saveFeedSettings, type NotifyFeed,
} from "../services/alarmService";
import {
  createTopic, deleteTopic, listMembers, addMember, removeMember, publish, isValidEmail,
} from "../services/notifyService";
import { conditionsFor, isValidCondition, intervalFor, type AlarmCondition } from "../alarms/conditions";
import {
  TEMPLATE_VARIABLES, unknownVariables, buildMessage,
  DEFAULT_ALARM_SUBJECT, DEFAULT_ALARM_BODY,
  DEFAULT_EACH_SUBJECT, DEFAULT_EACH_BODY,
} from "../alarms/message";
import { sanitizeError } from "../utils/errorSanitizer";
import { logActivity } from "../services/activityService";
import { GUARDRAIL_PREFIX, guardrailRuleOf } from "../alarms/conditions";
import { listGuardrails } from "../aws-guardrails/store";

const router = Router();

/**
 * Everything here is admin-only, reads included.
 *
 * Unlike a repository action, authorized by GitHub itself, because the call
 * carries the user's own token. These calls are not scoped to what the caller
 * can personally reach. Subscribing an address to a topic means this app can
 * send email to anyone. Reads are gated too because a group's member list is a
 * list of people's email addresses.
 *
 * Reading is open to **either** admin team, and writing depends on what the
 * alarm watches.
 *
 * This was Control Hub only, on the reasoning that alarms watch GitHub activity
 * and merely happen to be delivered by SNS. That was true when it was written
 * and stopped being true when guardrail alarms arrived: those watch AWS
 * findings, and the reasoning does not reach them.
 *
 * What it produced was backwards. Somebody who administers the AWS account
 * could not touch the alarms watching it, while somebody who administers only
 * the repositories could — including after the AWS tab itself was restricted to
 * the AWS team, which left the alarms more open than the screen they are about.
 *
 * So the subject decides: a `guardrail:` alarm belongs to the AWS team, a widget
 * alarm to the Control Hub team. The shared notification plumbing — groups,
 * their members, the Teams flow — stays Control Hub, because it is one set of
 * destinations for the whole organization rather than either team's own.
 */
const requireAdmin: RequestHandler = (req, res, next) => {
  isControlHubAdmin(req.user!.login, req.user!.accessToken)
    .then(allowed => {
      if (allowed) return next();
      res.status(403).json({
        code: "CONTROL_HUB_ADMIN_REQUIRED",
        error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can manage ` +
          `alarms and email groups. They send mail on behalf of the whole organization, so they ` +
          `are not scoped to what you personally can reach.`,
      });
    })
    .catch(() => res.status(503).json({ error: "Could not verify team membership" }));
};


/**
 * Either team, for reading.
 *
 * Both are administrator populations, and an AWS admin has to be able to see
 * the alarms watching their account and the groups those alarms notify —
 * otherwise they can be given the right to change something they cannot find.
 */
const requireEitherTeam: RequestHandler = (req, res, next) => {
  Promise.all([
    isControlHubAdmin(req.user!.login, req.user!.accessToken).catch(() => false),
    isAwsAdmin(req.user!.login, req.user!.accessToken).catch(() => false),
  ])
    .then(([hub, aws]) => {
      if (hub || aws) return next();
      res.status(403).json({
        code: "CONTROL_HUB_ADMIN_REQUIRED",
        team: CONTROL_HUB_ADMIN_TEAM,
        error: `Alarms are limited to the "${CONTROL_HUB_ADMIN_TEAM}" and `
          + `"${AWS_ADMIN_TEAM}" teams, and to organization owners.`,
      });
    })
    .catch(() => res.status(503).json({ error: "Could not verify team membership" }));
};

/**
 * The team that owns whatever this alarm watches.
 *
 * Read from the subject rather than from the request: an alarm's team is a fact
 * about what it is pointed at, and taking it from the body would let either
 * team claim the other's.
 */
async function refusedForSubject(
  req: Request, res: Response, subjectId: string,
): Promise<boolean> {
  const aws = subjectId.startsWith(GUARDRAIL_PREFIX);
  const allowed = aws
    ? await isAwsAdmin(req.user!.login, req.user!.accessToken).catch(() => null)
    : await isControlHubAdmin(req.user!.login, req.user!.accessToken).catch(() => null);

  // Null is "we could not ask", which is an outage. Refusing would tell
  // somebody they had lost a permission they still hold.
  if (allowed === null) {
    res.status(503).json({ error: "Could not verify team membership" });
    return true;
  }
  if (allowed) return false;

  const team = aws ? AWS_ADMIN_TEAM : CONTROL_HUB_ADMIN_TEAM;
  res.status(403).json({
    code: aws ? "AWS_ADMIN_REQUIRED" : "CONTROL_HUB_ADMIN_REQUIRED",
    team,
    error: aws
      ? `Alarms on AWS guardrails are limited to the "${team}" team, and to organization owners.`
      : `Alarms on widgets are limited to the "${team}" team, and to organization owners.`,
  });
  return true;
}

router.use(requireEitherTeam);

/**
 * An IANA zone the runtime recognises, or null.
 *
 * `Intl` is the authority rather than a list kept here, which would go stale
 * every time a government moves its clocks. Checked on the way in, because an
 * unknown zone is not an error further down: it renders as UTC, and the only
 * symptom is a timestamp quietly hours out.
 */
function knownZone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** Rejects a template naming a variable that will never be substituted. */
function templateProblem(
  subject?: string, body?: string,
  teamsSubject?: string, teamsBody?: string,
): string | null {
  for (const [what, tpl] of [
    ["subject", subject], ["body", body],
    ["Teams subject", teamsSubject], ["Teams body", teamsBody],
  ] as const) {
    // Undefined means "not being changed"; empty means "use the email
    // wording", which is a real value and needs no validating.
    if (tpl === undefined || tpl === "") continue;
    if (typeof tpl !== "string") return `The ${what} template must be text`;
    if (tpl.length > 4000) return `The ${what} template is too long`;
    const unknown = unknownVariables(tpl);
    if (unknown.length) {
      return `The ${what} template uses ${unknown.map(u => `{{${u}}}`).join(", ")}, ` +
        `which ${unknown.length > 1 ? "are" : "is"} not a real variable. ` +
        `Available: ${TEMPLATE_VARIABLES.map(v => `{{${v.name}}}`).join(", ")}`;
    }
  }
  return null;
}

// ── what a widget can be alarmed on ───────────────────────────────────

router.get("/variables", (_req: Request, res: Response) => {
  res.json(TEMPLATE_VARIABLES);
});

/**
 * The thing an alarm watches, which is not always a widget.
 *
 * A guardrail alarm's subject is synthesised from its id rather than stored:
 * there is no record to look up, because "the S3 rules" is not an object
 * somebody created. It is a view over the findings table. Resolving it here
 * means every route that validates an alarm handles both kinds without knowing
 * there are two.
 */
async function subjectFor(id: string): Promise<{ id: string; title?: string; type: string } | undefined> {
  if (id.startsWith(GUARDRAIL_PREFIX)) {
    const rule = guardrailRuleOf(id);
    if (!rule) return { id, type: "guardrail", title: "AWS guardrails" };
    const found = (await listGuardrails()).find(r => r.id === rule);
    // A rule that no longer exists is refused rather than watched: an alarm on
    // a deleted rule reads zero for ever, which looks exactly like compliance.
    return found ? { id, type: "guardrail", title: `Guardrail: ${found.name}` } : undefined;
  }
  return (await getWidget(id)) as any;
}

router.get("/widgets/:widgetId/conditions", async (req: Request, res: Response) => {
  const widget = await subjectFor(String(req.params.widgetId));
  if (!widget) return res.status(404).json({ error: "Widget not found" });
  res.json({
    widgetId: widget.id,
    title: widget.title,
    conditions: conditionsFor(widget as any),
    // Surfaced so the form can say how quickly this alarm will react rather
    // than leaving the user to guess.
    intervalMinutes: intervalFor(widget as any),
    // Two sets, because the two readings want different wording and the form
    // has to prefill whichever the person picks. Sent together rather than
    // fetched again on a dropdown change, which would put a request between a
    // click and the text appearing.
    defaults: { subject: DEFAULT_ALARM_SUBJECT, body: DEFAULT_ALARM_BODY },
    eachDefaults: { subject: DEFAULT_EACH_SUBJECT, body: DEFAULT_EACH_BODY },
  });
});

// ── alarms ────────────────────────────────────────────────────────────

router.get("/", async (_req: Request, res: Response) => {
  try {
    // The organization's, never anybody's own. A personal alarm watches a card
    // only its owner can see, so listing it here would put a stranger's private
    // alert in an administrator's table with a widget name they cannot open.
    const alarms = await listOrgAlarms();

    /**
     * How often each is evaluated, answered by the code that decides it.
     *
     * The list screen worked this out for itself, from the subject's kind, and
     * so said "checked every hour" about an alarm the evaluator now looks at
     * every tick. Two places deciding one number means one of them is wrong,
     * and it is always the copy.
     *
     * Subjects are resolved once per distinct id: several alarms commonly watch
     * one widget.
     */
    const subjects = new Map<string, any>();
    const withInterval = await Promise.all(alarms.map(async a => {
      if (!subjects.has(a.widgetId)) subjects.set(a.widgetId, await subjectFor(a.widgetId));
      const subject = subjects.get(a.widgetId);
      return {
        ...a,
        // A deleted subject has no interval to report. The row already says the
        // alarm is unreadable, so a number here would be the confident half of
        // a contradiction.
        intervalMinutes: subject ? intervalFor(subject) : null,
      };
    }));

    res.json(withInterval);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const { widgetId, name, condition, groupId, subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate,
            notifyOnRecovery, enabled } = req.body ?? {};

    if (!widgetId || !condition || !groupId) {
      return res.status(400).json({ error: "widgetId, condition and groupId are required" });
    }

    const widget = await subjectFor(widgetId);
    if (!widget) return res.status(404).json({ error: "Widget not found" });

    // Checked here rather than as route middleware: which team may create this
    // is decided by what it watches, and that is only known once the body has
    // been read.
    if (await refusedForSubject(req, res, String(widgetId))) return;

    // The load-bearing check. A condition its widget cannot produce would
    // evaluate to nothing on every pass and never fire, which is
    // indistinguishable from an alarm that is simply not triggering.
    if (!isValidCondition(widget as any, condition as AlarmCondition)) {
      return res.status(400).json({
        error: `That condition does not apply to this widget. It supports: ` +
          conditionsFor(widget as any).map(c => c.label).join(", "),
      });
    }

    const target = await getGroup(groupId);
    if (!target) {
      return res.status(400).json({ error: "That email group no longer exists" });
    }
    // The other half of keeping personal destinations private: without this an
    // organization alarm could be pointed at one person's own inbox, which is
    // both a surprise for them and a way to read what they subscribed.
    if (target.owner) {
      return res.status(400).json({ error: "That email group no longer exists" });
    }

    const problem = templateProblem(subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate);
    if (problem) return res.status(400).json({ error: problem });

    const alarm = await createAlarm({
      widgetId, name: String(name || widget.title || "Alarm").slice(0, 200),
      condition, groupId, subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate, notifyOnRecovery, enabled,
    }, req.user!.login);
    res.status(201).json(alarm);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

// ── email groups ──────────────────────────────────────────────────────

/**
 * A group as the browser may see it.
 *
 * The Teams URLs never leave the server. Each one is effectively a password for
 * posting into that channel, anybody holding it can post there indefinitely,
 * and the screen only needs to know how many are set, not what they are.
 */
function withoutHooks(g: any) {
  // Nothing to hide any more. Recipients are work email addresses, the same
  // shape as the email column beside them, so the screen shows who is on a
  // group instead of "Channel 1, Channel 2".
  return { ...g, teamsRecipients: g.teamsRecipients ?? [] };
}

router.get("/groups", async (_req: Request, res: Response) => {
  try {
    // Organization groups only. A personal group is where one person's own
    // alarms land; offering it here would let an administrator point an
    // organization alarm at somebody's private inbox, and would list that
    // person's addresses to everybody who can manage alarms.
    const groups = await listOrgGroups();
    // Members come from SNS rather than from our table, so the confirmation
    // state is the real one. An address that never confirmed receives nothing
    // and would otherwise look like a working recipient.
    const withMembers = await Promise.all(groups.map(async g => {
      try {
        return {
          ...withoutHooks(g),
          members: await listMembers(g.topicArn, g.revokedPending ?? []),
        };
      } catch (err) {
        return { ...withoutHooks(g), members: [], membersError: (err as Error).message };
      }
    }));
    res.json(withMembers);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

router.post("/groups", requireAdmin, async (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "A group needs a name" });
    if (name.length > 100) return res.status(400).json({ error: "That name is too long" });

    const topicArn = await createTopic(name);
    res.status(201).json(await createGroupRecord(name, topicArn, req.user!.login));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

router.delete("/groups/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const group = await getGroup(String(req.params.id));
    if (!group) return res.status(404).json({ error: "Group not found" });
    // Somebody's own destination is not an organization group, and on this
    // route it is not a thing that exists.
    if (group.owner) return res.status(404).json({ error: "Group not found" });

    // Deleting the topic under a live alarm would leave it firing into
    // nothing, which looks exactly like an alarm that never triggers.
    const inUse = await alarmsUsingGroup(String(req.params.id));
    if (inUse.length && !req.query.force) {
      return res.status(409).json({
        error: `${inUse.length} alarm${inUse.length > 1 ? "s" : ""} still notify this group: ` +
          inUse.map(a => a.name).join(", "),
        alarms: inUse.map(a => ({ id: a.id, name: a.name })),
      });
    }

    await deleteTopic(group.topicArn);
    await deleteGroupRecord(String(req.params.id), req.user!.login);
    res.json({ message: "Group deleted" });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

router.post("/groups/:id/members", requireAdmin, async (req: Request, res: Response) => {
  try {
    const group = await getGroup(String(req.params.id));
    if (!group) return res.status(404).json({ error: "Group not found" });

    const email = String(req.body?.email ?? "").trim();
    if (!isValidEmail(email)) return res.status(400).json({ error: "That does not look like an email address" });

    // Adding them back is the opposite of revoking them, so it has to clear the
    // record. Left in place, their new invitation would be hidden the moment
    // they confirmed it and then unsubscribed behind their back.
    if ((group.revokedPending ?? []).some(r => r.toLowerCase() === email.toLowerCase())) {
      await saveGroup({
        ...group,
        revokedPending: (group.revokedPending ?? [])
          .filter(r => r.toLowerCase() !== email.toLowerCase()),
        updatedAt: new Date().toISOString(),
      });
    }

    await addMember(group.topicArn, email);
    res.status(201).json({
      message: `AWS has emailed ${email} a confirmation link. ` +
        `Nothing is delivered to them until they click it.`,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

router.delete("/groups/:id/members", requireAdmin, async (req: Request, res: Response) => {
  try {
    const subscriptionArn = String(req.query.subscriptionArn ?? "");
    if (!subscriptionArn) return res.status(400).json({ error: "subscriptionArn is required" });

    // An unconfirmed subscription has no ARN to unsubscribe, and AWS provides
    // no way to withdraw one: it expires on its own after three days. So this
    // used to do nothing, say "Removed", and leave them in the list.
    //
    // Recorded as revoked instead. `listMembers` hides them from now on, and
    // unsubscribes them if the invitation is confirmed later.
    if (subscriptionArn === "PendingConfirmation") {
      const group = await getGroup(String(req.params.id));
      if (!group) return res.status(404).json({ error: "Group not found" });

      const email = String(req.query.email ?? "").trim().toLowerCase();
      if (!email) {
        return res.status(400).json({
          error: "Cancelling an unconfirmed invitation needs the address, "
            + "because there is no subscription to identify it by",
        });
      }

      const revoked = Array.from(new Set([...(group.revokedPending ?? []), email]));
      await saveGroup({ ...group, revokedPending: revoked, updatedAt: new Date().toISOString() });
      await logActivity("config.updated" as any, req.user!.login, "", "alarm group",
        `Cancelled an unconfirmed invitation to "${group.name}"`);
      return res.json({
        message: "Invitation cancelled. If they click the old link it will not subscribe them.",
      });
    }

    await removeMember(subscriptionArn);
    res.json({ message: "Removed" });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

/** Sends a real email, so a group can be proven to work before it is relied on. */
/**
 * Add a Teams channel to a group.
 *
 * The same allow-list as the personal notifications, and for the same reason: a
 * Lambda posts to whatever is stored here with no further checks, so anything
 * accepted is somewhere the app will send alarm text.
 */
router.post("/groups/:id/teams", requireAdmin, async (req: Request, res: Response) => {
  try {
    const group = await getGroup(String(req.params.id));
    if (!group) return res.status(404).json({ error: "No such group" });

    const address = String(req.body?.address ?? "").trim();
    const { badTeamsAddress } = await import("../services/devAlertService");
    const bad = badTeamsAddress(address);
    if (bad) return res.status(400).json({ error: bad });

    const people = group.teamsRecipients ?? [];
    // Adding somebody twice is a person unsure whether it took. The answer they
    // want is "they are on it", not a complaint.
    const already = people.some(p => p.toLowerCase() === address.toLowerCase());
    if (!already) {
      await saveGroup({
        ...group, teamsRecipients: [...people, address], updatedAt: new Date().toISOString(),
      });
    }
    await logActivity("config.updated" as any, req.user!.login, "", "alarm group",
      `Added ${address} to "${group.name}" in Teams`);
    res.json({ teamsRecipients: already ? people : [...people, address] });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

router.delete("/groups/:id/teams/:address", requireAdmin, async (req: Request, res: Response) => {
  try {
    const group = await getGroup(String(req.params.id));
    if (!group) return res.status(404).json({ error: "No such group" });

    const address = decodeURIComponent(String(req.params.address)).toLowerCase();
    const people = (group.teamsRecipients ?? []).filter(p => p.toLowerCase() !== address);
    // Their zone goes with them. Left behind, it would silently reattach to
    // anybody added under the same address later.
    const zones = { ...(group.recipientZones ?? {}) };
    for (const key of Object.keys(zones)) {
      if (key.toLowerCase() === address) delete zones[key];
    }
    await saveGroup({
      ...group, teamsRecipients: people, recipientZones: zones,
      updatedAt: new Date().toISOString(),
    });
    await logActivity("config.updated" as any, req.user!.login, "", "alarm group",
      `Removed a Teams recipient from "${group.name}"`);
    res.json({ teamsRecipients: people });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

/**
 * The zone one person on this group reads their times in.
 *
 * Set for anybody in either column. What it then does depends on the channel,
 * and the difference is physics rather than effort:
 *
 *   - **Teams** is called once per address, so that person's message is
 *     rendered in their own zone and nobody else's.
 *   - **Email** is one publish to one SNS topic, which hands every subscriber
 *     the identical body. There is no per-person text, so the one body names
 *     every zone its people are in: "10:30 AM EDT (7:30 AM PDT)". Each reader
 *     finds their own rather than one of them being right and the rest
 *     subtracting.
 *
 * Unset means the group's zone, and an unset group means the organization's.
 */
router.put("/groups/:id/people/:address/timezone", requireAdmin, async (req: Request, res: Response) => {
  try {
    const group = await getGroup(String(req.params.id));
    if (!group) return res.status(404).json({ error: "No such group" });

    const address = decodeURIComponent(String(req.params.address));

    // Either column. Both are people on this group and both are identified by
    // a work email address, so one map of zones covers them: an email member
    // who is also a Teams recipient is one person with one zone, not two.
    const teams = (group.teamsRecipients ?? [])
      .find(p => p.toLowerCase() === address.toLowerCase());
    const subscribed = await listMembers(group.topicArn, group.revokedPending ?? [])
      .then(ms => ms.find(m => m.endpoint.toLowerCase() === address.toLowerCase())?.endpoint)
      .catch(() => undefined);
    const known = teams ?? subscribed;
    if (!known) return res.status(404).json({ error: "That person is not in this group" });

    const raw = req.body?.timeZone;
    // Empty means "use the group's", which is a real choice and not a failure.
    const zone = raw === "" || raw === null || raw === undefined ? null : knownZone(raw);
    if (raw && !zone) return res.status(400).json({ error: `"${raw}" is not a timezone this system knows` });

    const zones = { ...(group.recipientZones ?? {}) };
    if (zone) zones[known] = zone;
    else delete zones[known];

    await saveGroup({ ...group, recipientZones: zones, updatedAt: new Date().toISOString() });
    await logActivity("config.updated" as any, req.user!.login, "", "alarm group",
      zone
        ? `Set a Teams recipient's timezone to ${zone} in "${group.name}"`
        : `Cleared a Teams recipient's timezone in "${group.name}"`);
    res.json({ recipientZones: zones });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

/**
 * The zone this group's email is written in, and the default for its Teams
 * people who have not set one.
 *
 * One value for the whole group, because one email reaches every subscriber
 * with the same body.
 */
router.put("/groups/:id/timezone", requireAdmin, async (req: Request, res: Response) => {
  try {
    const group = await getGroup(String(req.params.id));
    if (!group) return res.status(404).json({ error: "No such group" });

    const raw = req.body?.timeZone;
    const zone = raw === "" || raw === null || raw === undefined ? null : knownZone(raw);
    if (raw && !zone) return res.status(400).json({ error: `"${raw}" is not a timezone this system knows` });

    await saveGroup({
      ...group, timeZone: zone ?? undefined, updatedAt: new Date().toISOString(),
    });
    await logActivity("config.updated" as any, req.user!.login, "", "alarm group",
      zone ? `Set "${group.name}" to ${zone}` : `Cleared the timezone on "${group.name}"`);
    res.json({ timeZone: zone ?? undefined });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

/**
 * The one flow every Teams message goes through.
 *
 * Set once, by an administrator. Everybody else supplies an address and never
 * opens Power Automate.
 */
router.get("/teams-flow", async (_req: Request, res: Response) => {
  try {
    const { getOrgConfig } = await import("../services/orgConfigService");
    const flow = (await getOrgConfig()).teamsFlow;
    // The URL is not returned. It is the one credential here: anybody holding
    // it can post as the flow, to anyone.
    res.json({ configured: !!flow?.url, setBy: flow?.setBy, setAt: flow?.setAt });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

router.put("/teams-flow", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { setTeamsFlow } = await import("../services/orgConfigService");
    const raw = String(req.body?.url ?? "").trim();

    if (raw === "") {
      await setTeamsFlow(null, req.user!.login);
      await logActivity("config.updated" as any, req.user!.login, "", "teams flow",
        "Removed the Teams delivery flow");
      return res.json({ configured: false });
    }

    const { badWebhook } = await import("../services/devAlertService");
    const bad = badWebhook(raw);
    if (bad) return res.status(400).json({ error: bad });

    const saved = await setTeamsFlow(raw, req.user!.login);
    await logActivity("config.updated" as any, req.user!.login, "", "teams flow",
      "Set the Teams delivery flow");
    res.json({ configured: true, setBy: saved.teamsFlow?.setBy, setAt: saved.teamsFlow?.setAt });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

router.post("/groups/:id/test", requireAdmin, async (req: Request, res: Response) => {
  try {
    const group = await getGroup(String(req.params.id));
    if (!group) return res.status(404).json({ error: "Group not found" });

    const { subject, body } = buildMessage(
      "[TEST] {{org}} Control Hub notification test",
      `This is a test message from GitHub Control Hub, sent to the "${group.name}" group.\n\n` +
      `If you received this, alarms pointed at this group will reach you.\n\nSent at {{time}}`,
      { org: process.env.GITHUB_ORG || "", time: new Date().toISOString() },
    );

    const ok = await publish(group.topicArn, subject, body);
    if (!ok) return res.status(502).json({ error: "SNS refused the message" });
    res.json({
      message: "Test sent. Only confirmed addresses will receive it, " +
        "anyone still pending has to click their confirmation link first.",
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

// ── the security-tab toggle ───────────────────────────────────────────

router.get("/security", async (_req: Request, res: Response) => {
  res.json(await getSecuritySettings());
});

router.put("/security", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { enabled, groupId, minSeverity, subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate, timezone } = req.body ?? {};

    if (enabled && !groupId) {
      return res.status(400).json({ error: "Choose an email group before turning this on" });
    }
    if (groupId && !(await getGroup(groupId))) {
      return res.status(400).json({ error: "That email group no longer exists" });
    }
    if (minSeverity && !["critical", "high", "medium", "low"].includes(minSeverity)) {
      return res.status(400).json({ error: "Unknown severity" });
    }

    // Rejected here rather than at send time: an unknown zone makes
    // Intl.DateTimeFormat throw, and a thrown formatter takes the email with it.
    if (timezone !== undefined) {
      try { new Intl.DateTimeFormat("en-CA", { timeZone: timezone }); }
      catch { return res.status(400).json({ error: `"${timezone}" is not a known timezone` }); }
    }

    const problem = templateProblem(subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate);
    if (problem) return res.status(400).json({ error: problem });

    res.json(await saveSecuritySettings(
      { enabled, groupId, minSeverity, subjectTemplate, bodyTemplate,
        teamsSubjectTemplate, teamsBodyTemplate, timezone }, req.user!.login));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm settings") });
  }
});

// ── the Vulnerabilities-tab toggles ───────────────────────────────────
//
// One pair of routes for both feeds rather than two pairs. They differ only in
// whether a severity floor applies, and that difference is enforced in the
// service, so a second handler would duplicate the validation with it.

const FEEDS = ["renovate-pr", "dependabot-alert"] as const;

router.get("/feeds/:feed", async (req: Request<{ feed: string }>, res: Response) => {
  const feed = String(req.params.feed);
  if (!(FEEDS as readonly string[]).includes(feed)) {
    return res.status(404).json({ error: "Unknown notification feed" });
  }
  try {
    res.json(await getFeedSettings(feed as NotifyFeed));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "notification settings") });
  }
});

router.put("/feeds/:feed", requireAdmin, async (req: Request<{ feed: string }>, res: Response) => {
  const feed = String(req.params.feed);
  if (!(FEEDS as readonly string[]).includes(feed)) {
    return res.status(404).json({ error: "Unknown notification feed" });
  }
  try {
    const { enabled, groupId, minSeverity, grouping, subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate } = req.body ?? {};

    if (grouping !== undefined && !["per-alert", "per-repository"].includes(grouping)) {
      return res.status(400).json({ error: "Grouping must be per-alert or per-repository" });
    }

    if (enabled && !groupId) {
      return res.status(400).json({ error: "Choose an email group before turning this on" });
    }
    if (groupId && !(await getGroup(groupId))) {
      return res.status(400).json({ error: "That email group no longer exists" });
    }
    if (minSeverity !== undefined) {
      // Refused rather than ignored on the Renovate feed. Accepting it would
      // show a floor that filters nothing, which is worse than an error: the
      // mail keeps arriving while the setting says it should not.
      if (feed !== "dependabot-alert") {
        return res.status(400).json({ error: "Renovate pull requests carry no severity" });
      }
      if (!["critical", "high", "medium", "low"].includes(minSeverity)) {
        return res.status(400).json({ error: "Unknown severity" });
      }
    }

    const problem = templateProblem(subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate);
    if (problem) return res.status(400).json({ error: problem });

    res.json(await saveFeedSettings(
      feed as NotifyFeed,
      { enabled, groupId, minSeverity, grouping, subjectTemplate, bodyTemplate,
        teamsSubjectTemplate, teamsBodyTemplate },
      req.user!.login,
    ));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "notification settings") });
  }
});

// ── parameterised routes last ────────────────────────────────────────
//
// Express matches in registration order, so `/:id` registered above would
// swallow `/security`, a PUT to the security toggle would arrive here as an
// alarm with id "security" and 404, which reads as the toggle being broken.
// `/feeds/:feed` is two segments and cannot collide, but it is registered above
// anyway: the rule that keeps this working is position, not path shape.

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await getAlarm(String(req.params.id));
    if (!existing) return res.status(404).json({ error: "Alarm not found" });
    // Somebody's own alarm is theirs to change, on their own route. Being an
    // administrator is permission over the organization's settings, not over
    // what lands in one person's inbox.
    if (existing.owner) return res.status(404).json({ error: "Alarm not found" });
    if (await refusedForSubject(req, res, existing.widgetId)) return;

    const { condition, groupId, subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate } = req.body ?? {};

    if (condition !== undefined) {
      // `subjectFor`, not `getWidget`. A guardrail alarm watches a rule, and
      // there is no widget record to find: creating one went through here and
      // editing one did not, so every guardrail alarm could be created and
      // then never changed, refused with "the widget this alarm watches no
      // longer exists" about a widget that had never existed.
      const widget = await subjectFor(existing.widgetId);
      if (!widget) return res.status(400).json({ error: "The subject this alarm watches no longer exists" });
      if (!isValidCondition(widget as any, condition as AlarmCondition)) {
        return res.status(400).json({
          error: `That condition does not apply to this widget. It supports: ` +
            conditionsFor(widget as any).map(c => c.label).join(", "),
        });
      }
    }

    if (groupId !== undefined) {
      const target = await getGroup(groupId);
      // A personal destination is not a group this route can point at, for the
      // same reason it is not one this route can list.
      if (!target || target.owner) {
        return res.status(400).json({ error: "That email group no longer exists" });
      }
    }

    const problem = templateProblem(subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate);
    if (problem) return res.status(400).json({ error: problem });

    res.json(await updateAlarm(String(req.params.id), req.body ?? {}, req.user!.login));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  const existing = await getAlarm(String(req.params.id));
  // Absent and somebody-else's answer identically here: on this route a
  // personal alarm is not a thing that exists.
  if (!existing || existing.owner) return res.status(404).json({ error: "Alarm not found" });
  if (await refusedForSubject(req, res, existing.widgetId)) return;
  const ok = await deleteAlarm(String(req.params.id), req.user!.login);
  if (!ok) return res.status(404).json({ error: "Alarm not found" });
  res.json({ message: "Alarm deleted" });
});

export default router;
