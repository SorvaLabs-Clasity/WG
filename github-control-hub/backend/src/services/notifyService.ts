import { awsRegion } from "../utils/region";

/**
 * The SNS side of alarms: topics as email groups, and publishing to them.
 *
 * Every topic this creates is named with the stack prefix, which is what lets
 * the Lambdas' IAM be scoped to `${prefix}-notify-*` rather than to every topic
 * in the account. A group whose topic sits outside that prefix cannot be
 * published to, so the naming here is a permission boundary and not a
 * convention.
 */

const PREFIX = () => process.env.STACK_NAME || "github-control-hub";

/** Topic names are `<prefix>-notify-<slug>`. The prefix is what IAM matches. */
export function topicNameFor(groupName: string): string {
  const slug = groupName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // A name of only punctuation would otherwise produce a trailing hyphen and
  // an SNS rejection that reads as an AWS problem rather than a naming one.
  return `${PREFIX()}-notify-${slug || "group"}`;
}

/**
 * Addresses are typed by a person and handed to AWS. Rejecting the obviously
 * wrong ones here turns a confusing SNS error into a field validation message,
 * and keeps anything with a newline in it out of an API call.
 */
export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  if (/[\s<>",;\\]/.test(email)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(email);
}

async function sns() {
  const {
    SNSClient, CreateTopicCommand, DeleteTopicCommand, SubscribeCommand,
    UnsubscribeCommand, ListSubscriptionsByTopicCommand, PublishCommand,
    SetTopicAttributesCommand,
  } = await import("@aws-sdk/client-sns");
  return {
    client: new SNSClient({ region: awsRegion() }),
    CreateTopicCommand, DeleteTopicCommand, SubscribeCommand, UnsubscribeCommand,
    ListSubscriptionsByTopicCommand, PublishCommand, SetTopicAttributesCommand,
  };
}

export interface GroupMember {
  endpoint: string;
  subscriptionArn: string;
  /** SNS reports "PendingConfirmation" until the recipient clicks the link. */
  confirmed: boolean;
}

export async function createTopic(groupName: string): Promise<string> {
  const { client, CreateTopicCommand, SetTopicAttributesCommand } = await sns();
  const name = topicNameFor(groupName);
  // CreateTopic is idempotent: an existing topic of the same name is returned
  // rather than duplicated, so two groups with the same slug share a topic
  // instead of one of them failing.
  const res = await client.send(new CreateTopicCommand({ Name: name }));
  const arn = res.TopicArn!;
  await client.send(new SetTopicAttributesCommand({
    TopicArn: arn,
    AttributeName: "DisplayName",
    // SNS puts DisplayName in the From line and truncates past 10 characters,
    // so this is the short form rather than the group's full name.
    AttributeValue: "ControlHub",
  }));
  return arn;
}

export async function deleteTopic(topicArn: string): Promise<void> {
  const { client, DeleteTopicCommand } = await sns();
  await client.send(new DeleteTopicCommand({ TopicArn: topicArn }));
}

export async function listMembers(topicArn: string): Promise<GroupMember[]> {
  const { client, ListSubscriptionsByTopicCommand } = await sns();
  const members: GroupMember[] = [];
  let token: string | undefined;
  do {
    const res: any = await client.send(new ListSubscriptionsByTopicCommand({
      TopicArn: topicArn, NextToken: token,
    }));
    for (const s of res.Subscriptions || []) {
      if (s.Protocol !== "email") continue;
      members.push({
        endpoint: s.Endpoint || "",
        subscriptionArn: s.SubscriptionArn || "",
        confirmed: !!s.SubscriptionArn && s.SubscriptionArn !== "PendingConfirmation",
      });
    }
    token = res.NextToken;
  } while (token);
  return members;
}

export async function addMember(topicArn: string, email: string): Promise<void> {
  const { client, SubscribeCommand } = await sns();
  await client.send(new SubscribeCommand({
    TopicArn: topicArn, Protocol: "email", Endpoint: email,
  }));
}

export async function removeMember(subscriptionArn: string): Promise<void> {
  // An unconfirmed subscription has no real ARN to delete; it expires on its
  // own after three days. Calling Unsubscribe with the placeholder would throw.
  if (!subscriptionArn || subscriptionArn === "PendingConfirmation") return;
  const { client, UnsubscribeCommand } = await sns();
  await client.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
}

/**
 * Send. Returns false rather than throwing when the topic will not accept the
 * message, because a failed notification must not fail the thing that
 * triggered it, a security alert still has to be recorded even if nobody can
 * be emailed about it.
 */
/**
 * Tell everybody in this group, by every channel they have.
 *
 * The one seam every notification in the app passes through, widget alarms,
 * important events, pull request reminders, the Renovate feed, so a delivery
 * channel added here reaches all of them at once, and none of them has to know
 * it exists.
 *
 * True when *anybody* was reached. A group with a working Teams webhook and a
 * broken topic has still notified somebody, and reporting that as a failure
 * would make the caller record an alarm as unsent when it was seen.
 *
 * The two are attempted independently and neither can fail the other: a stale
 * Teams webhook must not stop the email, which is the channel people are more
 * likely to be relying on.
 */
export async function publish(topicArn: string, subject: string, body: string): Promise<boolean> {
  const [email, teams] = await Promise.all([
    publishEmail(topicArn, subject, body),
    publishTeams(topicArn, subject, body),
  ]);
  return email || teams;
}

async function publishEmail(topicArn: string, subject: string, body: string): Promise<boolean> {
  try {
    const { client, PublishCommand } = await sns();
    await client.send(new PublishCommand({
      TopicArn: topicArn, Subject: subject, Message: body,
    }));
    return true;
  } catch (err) {
    console.error(`[Alarm] Could not publish to ${topicArn}:`, (err as Error).message);
    return false;
  }
}

/**
 * The same message, as a Teams card.
 *
 * Imported lazily so that a deployment with no Teams webhooks anywhere never
 * loads the card builder, and, more to the point, so this module does not
 * take a static dependency on the alarm store, which imports plenty of its own.
 *
 * Returns false when the group has no webhooks, which is the ordinary case and
 * not a failure. The caller's `email || teams` is what makes that harmless.
 */
async function publishTeams(topicArn: string, subject: string, body: string): Promise<boolean> {
  try {
    const { groupByTopic } = await import("./alarmService");
    const group = await groupByTopic(topicArn);
    const people = group?.teamsRecipients ?? [];
    if (people.length === 0) return false;

    // One shared flow for the whole organization. Unset means nobody has set
    // Teams up yet, which is not a failure of this alarm.
    const { getOrgConfig } = await import("./orgConfigService");
    const flowUrl = (await getOrgConfig()).teamsFlow?.url;
    if (!flowUrl) {
      console.warn(`[Notify] "${group!.name}" has Teams recipients but no flow is configured`);
      return false;
    }

    const { buildCard, sendToPerson } = await import("./teamsClient");
    const card = buildCard(subject, group!.name, [{ heading: "", links: [], emptyText: body }]);

    // One request per person: the flow reads who each message is for. Sent in
    // parallel, and one bad address does not stop the rest.
    const results = await Promise.all(
      people.map((address: string) => sendToPerson(flowUrl, address, card)));
    results.forEach((r, i) => {
      if (!r.ok) console.warn(`[Notify] Teams to ${people[i]} for "${group!.name}": ${r.error}`);
    });
    return results.some(r => r.ok);
  } catch (err) {
    // Never allowed to take the email down with it.
    console.warn("[Notify] Teams delivery failed:", (err as Error).message);
    return false;
  }
}
