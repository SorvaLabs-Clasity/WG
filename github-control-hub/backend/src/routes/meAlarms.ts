import { Router, Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
import {
  getOrCreatePersonalGroup, listPersonalAlarms, getAlarm, createAlarm,
  updateAlarm, deleteAlarm, saveGroup,
} from "../services/alarmService";
import { listWidgets, getWidget } from "../services/widgetService";
import { addMember, removeMember, listMembers } from "../services/notifyService";
import { isValidCondition, conditionsFor, intervalFor } from "../alarms/conditions";
import type { AlarmCondition } from "../alarms/conditions";

const router = Router();

/**
 * Somebody's own alarms, on their own widgets, delivered to their own address.
 *
 * A separate router rather than a scope on the organization one, because that
 * one is gated on the Control Hub admin team and this must not be. The gate is
 * there for a real reason — subscribing an address to a topic means this app can
 * send mail — so everything here is narrowed until that reason no longer
 * applies:
 *
 *   - the group is **never** taken from the request. It is resolved from the
 *     session, so this cannot point an alarm at an organization topic or at
 *     somebody else's inbox.
 *   - the widget must be one the caller owns, checked against what is stored.
 *   - an alarm is the caller's only if its stored `owner` says so. An
 *     administrator is refused here like anybody else: they have no more
 *     business reading somebody's private alerts than rearranging their
 *     dashboard.
 *
 * What is left is that somebody can have AWS send a confirmation email to an
 * address they typed. SNS delivers nothing until that address confirms, and the
 * list is capped, so the widest this reaches is a handful of one-off
 * confirmation emails — recorded in the activity feed like every other change.
 */

/** As many places as one person plausibly reads their own alerts. */
const MAX_PERSONAL_EMAILS = 5;
const MAX_PERSONAL_TEAMS = 5;

const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;

/** The caller's alarm, or a reason it is not theirs to touch. */
async function mine(req: Request, res: Response) {
  const alarm = await getAlarm(String(req.params.id));
  if (!alarm) { res.status(404).json({ error: "Alarm not found" }); return null; }
  if (!alarm.owner || alarm.owner.toLowerCase() !== req.user!.login.toLowerCase()) {
    // Not 403: on this route an alarm somebody else owns is not a thing that
    // exists, and saying "you may not touch that" confirms it does.
    res.status(404).json({ error: "Alarm not found" });
    return null;
  }
  return alarm;
}

/** Whether this widget is the caller's own card. */
async function ownsWidget(login: string, widgetId: string): Promise<boolean> {
  const widget = (await listWidgets()).find(w => w.id === widgetId);
  return !!widget?.owner && widget.owner.toLowerCase() === login.toLowerCase();
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const alarms = await listPersonalAlarms(req.user!.login);
    const subjects = new Map<string, any>();
    const withInterval = await Promise.all(alarms.map(async a => {
      if (!subjects.has(a.widgetId)) subjects.set(a.widgetId, await getWidget(a.widgetId));
      const subject = subjects.get(a.widgetId);
      return { ...a, intervalMinutes: subject ? intervalFor(subject) : null };
    }));
    res.json(withInterval);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const { widgetId, name, condition, subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate, notifyOnRecovery, enabled } = req.body ?? {};

    if (!widgetId || !condition) {
      return res.status(400).json({ error: "widgetId and condition are required" });
    }
    if (!(await ownsWidget(req.user!.login, String(widgetId)))) {
      return res.status(404).json({ error: "That card is not on your board" });
    }

    const widget = await getWidget(String(widgetId));
    if (!widget) return res.status(404).json({ error: "Widget not found" });

    // A condition its widget cannot produce evaluates to nothing on every pass
    // and never fires, which looks exactly like an alarm that is not triggering.
    if (!isValidCondition(widget as any, condition as AlarmCondition)) {
      return res.status(400).json({
        error: "That condition does not apply to this card. It supports: "
          + conditionsFor(widget as any).map(c => c.label).join(", "),
      });
    }

    // From the session, never the body. This is the line that keeps a personal
    // alarm from becoming a way to mail the organization.
    const group = await getOrCreatePersonalGroup(req.user!.login);

    const alarm = await createAlarm({
      widgetId: String(widgetId),
      name: String(name || widget.title || "Alarm").slice(0, 120),
      condition, groupId: group.id,
      subjectTemplate, bodyTemplate, teamsSubjectTemplate, teamsBodyTemplate,
      notifyOnRecovery, enabled,
      owner: req.user!.login,
    }, req.user!.login);

    res.status(201).json(alarm);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const alarm = await mine(req, res);
    if (!alarm) return;

    const { name, condition, subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate, notifyOnRecovery, enabled } = req.body ?? {};

    if (condition) {
      const widget = await getWidget(alarm.widgetId);
      if (!widget) return res.status(404).json({ error: "The card this alarm watches no longer exists" });
      if (!isValidCondition(widget as any, condition as AlarmCondition)) {
        return res.status(400).json({
          error: "That condition does not apply to this card. It supports: "
            + conditionsFor(widget as any).map(c => c.label).join(", "),
        });
      }
    }

    // `groupId` and `owner` are deliberately not settable here. Letting either
    // through would undo every narrowing above in one request.
    const updated = await updateAlarm(alarm.id, {
      name, condition, subjectTemplate, bodyTemplate,
      teamsSubjectTemplate, teamsBodyTemplate, notifyOnRecovery, enabled,
    }, req.user!.login);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const alarm = await mine(req, res);
    if (!alarm) return;
    await deleteAlarm(alarm.id, req.user!.login);
    res.json({ message: "Alarm deleted" });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

// ── where they are delivered ──

router.get("/destination", async (req: Request, res: Response) => {
  try {
    const group = await getOrCreatePersonalGroup(req.user!.login);
    // Pending invitations included, and marked: an address that has not
    // confirmed receives nothing, and a list that showed it as active would
    // explain neither the silence nor how to fix it.
    const emails = await listMembers(group.topicArn, group.revokedPending ?? [])
      .catch(() => [] as any[]);
    res.json({
      groupId: group.id,
      emails,
      teams: group.teamsRecipients ?? [],
      timeZone: group.timeZone ?? null,
      recipientZones: group.recipientZones ?? {},
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.post("/destination/email", async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email ?? "").trim();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "That does not look like an email address" });
    }
    const group = await getOrCreatePersonalGroup(req.user!.login);
    const existing = await listMembers(group.topicArn, group.revokedPending ?? [])
      .catch(() => [] as any[]);
    if (existing.length >= MAX_PERSONAL_EMAILS) {
      return res.status(400).json({
        error: `You can send your own alarms to ${MAX_PERSONAL_EMAILS} addresses. `
          + "Remove one to add another.",
      });
    }

    // Adding them back is the opposite of revoking them, so it clears the
    // record: otherwise the new invitation is hidden the moment it is confirmed
    // and then unsubscribed behind their back.
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
      message: `AWS has emailed ${email} a confirmation link. `
        + "Nothing is delivered there until it is clicked.",
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.delete("/destination/email", async (req: Request, res: Response) => {
  try {
    const group = await getOrCreatePersonalGroup(req.user!.login);
    const subscriptionArn = String(req.query.subscriptionArn ?? "");
    const email = String(req.query.email ?? "").trim();

    // An unconfirmed subscription has no ARN to unsubscribe and AWS offers no
    // way to withdraw one; it expires on its own after three days. Recorded
    // instead, so the row goes at once and a later confirmation is undone.
    if (!subscriptionArn || subscriptionArn === "PendingConfirmation") {
      if (!email) return res.status(400).json({ error: "email is required" });
      await saveGroup({
        ...group,
        revokedPending: [...new Set([...(group.revokedPending ?? []), email])],
        updatedAt: new Date().toISOString(),
      });
      return res.json({ message: "Invitation cancelled" });
    }

    // Bound to this person's own topic, so an ARN from somewhere else cannot be
    // passed in to unsubscribe a stranger from a group they do not own.
    if (!subscriptionArn.startsWith(`${group.topicArn}:`)) {
      return res.status(400).json({ error: "That subscription is not on your list" });
    }
    await removeMember(subscriptionArn);
    res.json({ message: "Removed" });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.post("/destination/teams", async (req: Request, res: Response) => {
  try {
    const address = String(req.body?.address ?? "").trim();
    if (!isValidEmail(address)) {
      return res.status(400).json({ error: "A Teams address is a work email address" });
    }
    const group = await getOrCreatePersonalGroup(req.user!.login);
    const current = group.teamsRecipients ?? [];
    if (current.some(a => a.toLowerCase() === address.toLowerCase())) {
      return res.status(409).json({ error: "That address is already on your list" });
    }
    if (current.length >= MAX_PERSONAL_TEAMS) {
      return res.status(400).json({
        error: `You can message ${MAX_PERSONAL_TEAMS} Teams addresses. Remove one to add another.`,
      });
    }
    await saveGroup({
      ...group,
      teamsRecipients: [...current, address],
      updatedAt: new Date().toISOString(),
    });
    res.status(201).json({ message: `${address} will be messaged in Teams` });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.delete("/destination/teams/:address", async (req: Request, res: Response) => {
  try {
    const address = String(req.params.address ?? "");
    const group = await getOrCreatePersonalGroup(req.user!.login);
    const zones = { ...(group.recipientZones ?? {}) };
    delete zones[address];
    await saveGroup({
      ...group,
      teamsRecipients: (group.teamsRecipients ?? [])
        .filter(a => a.toLowerCase() !== address.toLowerCase()),
      recipientZones: zones,
      updatedAt: new Date().toISOString(),
    });
    res.json({ message: "Removed" });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

router.put("/destination/timezone", async (req: Request, res: Response) => {
  try {
    const raw = req.body?.timeZone;
    const zone = raw === null || raw === "" ? undefined : String(raw);
    if (zone) {
      // `Intl` is the authority rather than a list kept here, which goes stale.
      try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); }
      catch { return res.status(400).json({ error: `${zone} is not a timezone this system knows` }); }
    }
    const group = await getOrCreatePersonalGroup(req.user!.login);
    await saveGroup({ ...group, timeZone: zone, updatedAt: new Date().toISOString() });
    res.json({ message: zone ? `Times will be written in ${zone}` : "Using the organization's timezone" });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "alarms") });
  }
});

export default router;
