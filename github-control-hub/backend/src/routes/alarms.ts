import { Router, Request, Response, RequestHandler } from "express";

import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import { getWidget } from "../services/widgetService";
import {
  listAlarms, getAlarm, createAlarm, updateAlarm, deleteAlarm,
  listGroups, getGroup, createGroupRecord, deleteGroupRecord, alarmsUsingGroup,
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
} from "../alarms/message";
import { sanitizeError } from "../utils/errorSanitizer";

const router = Router();

/**
 * Everything here is admin-only, reads included.
 *
 * Unlike a repository action — authorized by GitHub itself, because the call
 * carries the user's own token — these calls are not scoped to what the caller
 * can personally reach. Subscribing an address to a topic means this app can
 * send email to anyone. Reads are gated too because a group's member list is a
 * list of people's email addresses.
 *
 * Gated on the Control Hub team, not the AWS one. Alarms watch GitHub activity
 * and mail people about it; that they happen to be delivered by SNS is an
 * implementation detail, and gating on it meant someone trusted with every
 * GitHub setting in this app could not create an alarm unless they were also
 * trusted with the AWS account.
 */
const requireAdmin: RequestHandler = (req, res, next) => {
  isControlHubAdmin(req.user!.login)
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

router.use(requireAdmin);

/** Rejects a template naming a variable that will never be substituted. */
function templateProblem(subject?: string, body?: string): string | null {
  for (const [what, tpl] of [["subject", subject], ["body", body]] as const) {
    if (tpl === undefined) continue;
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

router.get("/widgets/:widgetId/conditions", async (req: Request, res: Response) => {
  const widget = await getWidget(String(req.params.widgetId));
  if (!widget) return res.status(404).json({ error: "Widget not found" });
  res.json({
    widgetId: widget.id,
    title: widget.title,
    conditions: conditionsFor(widget as any),
    // Surfaced so the form can say how quickly this alarm will react rather
    // than leaving the user to guess.
    intervalMinutes: intervalFor(widget as any),
    defaults: { subject: DEFAULT_ALARM_SUBJECT, body: DEFAULT_ALARM_BODY },
  });
});

// ── alarms ────────────────────────────────────────────────────────────

router.get("/", async (_req: Request, res: Response) => {
  try {
    res.json(await listAlarms());
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const { widgetId, name, condition, groupId, subjectTemplate, bodyTemplate,
            notifyOnRecovery, enabled } = req.body ?? {};

    if (!widgetId || !condition || !groupId) {
      return res.status(400).json({ error: "widgetId, condition and groupId are required" });
    }

    const widget = await getWidget(widgetId);
    if (!widget) return res.status(404).json({ error: "Widget not found" });

    // The load-bearing check. A condition its widget cannot produce would
    // evaluate to nothing on every pass and never fire, which is
    // indistinguishable from an alarm that is simply not triggering.
    if (!isValidCondition(widget as any, condition as AlarmCondition)) {
      return res.status(400).json({
        error: `That condition does not apply to this widget. It supports: ` +
          conditionsFor(widget as any).map(c => c.label).join(", "),
      });
    }

    if (!(await getGroup(groupId))) {
      return res.status(400).json({ error: "That email group no longer exists" });
    }

    const problem = templateProblem(subjectTemplate, bodyTemplate);
    if (problem) return res.status(400).json({ error: problem });

    const alarm = await createAlarm({
      widgetId, name: String(name || widget.title || "Alarm").slice(0, 200),
      condition, groupId, subjectTemplate, bodyTemplate, notifyOnRecovery, enabled,
    }, req.user!.login);
    res.status(201).json(alarm);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

// ── email groups ──────────────────────────────────────────────────────

router.get("/groups", async (_req: Request, res: Response) => {
  try {
    const groups = await listGroups();
    // Members come from SNS rather than from our table, so the confirmation
    // state is the real one. An address that never confirmed receives nothing
    // and would otherwise look like a working recipient.
    const withMembers = await Promise.all(groups.map(async g => {
      try {
        return { ...g, members: await listMembers(g.topicArn) };
      } catch (err) {
        return { ...g, members: [], membersError: (err as Error).message };
      }
    }));
    res.json(withMembers);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

router.post("/groups", async (req: Request, res: Response) => {
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

router.delete("/groups/:id", async (req: Request, res: Response) => {
  try {
    const group = await getGroup(String(req.params.id));
    if (!group) return res.status(404).json({ error: "Group not found" });

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

router.post("/groups/:id/members", async (req: Request, res: Response) => {
  try {
    const group = await getGroup(String(req.params.id));
    if (!group) return res.status(404).json({ error: "Group not found" });

    const email = String(req.body?.email ?? "").trim();
    if (!isValidEmail(email)) return res.status(400).json({ error: "That does not look like an email address" });

    await addMember(group.topicArn, email);
    res.status(201).json({
      message: `AWS has emailed ${email} a confirmation link. ` +
        `Nothing is delivered to them until they click it.`,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

router.delete("/groups/:id/members", async (req: Request, res: Response) => {
  try {
    const subscriptionArn = String(req.query.subscriptionArn ?? "");
    if (!subscriptionArn) return res.status(400).json({ error: "subscriptionArn is required" });
    await removeMember(subscriptionArn);
    res.json({ message: "Removed" });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarm groups") });
  }
});

/** Sends a real email, so a group can be proven to work before it is relied on. */
router.post("/groups/:id/test", async (req: Request, res: Response) => {
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
      message: "Test sent. Only confirmed addresses will receive it — " +
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

router.put("/security", async (req: Request, res: Response) => {
  try {
    const { enabled, groupId, minSeverity, subjectTemplate, bodyTemplate, timezone } = req.body ?? {};

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

    const problem = templateProblem(subjectTemplate, bodyTemplate);
    if (problem) return res.status(400).json({ error: problem });

    res.json(await saveSecuritySettings(
      { enabled, groupId, minSeverity, subjectTemplate, bodyTemplate, timezone }, req.user!.login));
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

router.put("/feeds/:feed", async (req: Request<{ feed: string }>, res: Response) => {
  const feed = String(req.params.feed);
  if (!(FEEDS as readonly string[]).includes(feed)) {
    return res.status(404).json({ error: "Unknown notification feed" });
  }
  try {
    const { enabled, groupId, minSeverity, grouping, subjectTemplate, bodyTemplate } = req.body ?? {};

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

    const problem = templateProblem(subjectTemplate, bodyTemplate);
    if (problem) return res.status(400).json({ error: problem });

    res.json(await saveFeedSettings(
      feed as NotifyFeed,
      { enabled, groupId, minSeverity, grouping, subjectTemplate, bodyTemplate },
      req.user!.login,
    ));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "notification settings") });
  }
});

// ── parameterised routes last ────────────────────────────────────────
//
// Express matches in registration order, so `/:id` registered above would
// swallow `/security` — a PUT to the security toggle would arrive here as an
// alarm with id "security" and 404, which reads as the toggle being broken.
// `/feeds/:feed` is two segments and cannot collide, but it is registered above
// anyway: the rule that keeps this working is position, not path shape.

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await getAlarm(String(req.params.id));
    if (!existing) return res.status(404).json({ error: "Alarm not found" });

    const { condition, groupId, subjectTemplate, bodyTemplate } = req.body ?? {};

    if (condition !== undefined) {
      const widget = await getWidget(existing.widgetId);
      if (!widget) return res.status(400).json({ error: "The widget this alarm watches no longer exists" });
      if (!isValidCondition(widget as any, condition as AlarmCondition)) {
        return res.status(400).json({
          error: `That condition does not apply to this widget. It supports: ` +
            conditionsFor(widget as any).map(c => c.label).join(", "),
        });
      }
    }

    if (groupId !== undefined && !(await getGroup(groupId))) {
      return res.status(400).json({ error: "That email group no longer exists" });
    }

    const problem = templateProblem(subjectTemplate, bodyTemplate);
    if (problem) return res.status(400).json({ error: problem });

    res.json(await updateAlarm(String(req.params.id), req.body ?? {}, req.user!.login));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  const ok = await deleteAlarm(String(req.params.id), req.user!.login);
  if (!ok) return res.status(404).json({ error: "Alarm not found" });
  res.json({ message: "Alarm deleted" });
});

export default router;
