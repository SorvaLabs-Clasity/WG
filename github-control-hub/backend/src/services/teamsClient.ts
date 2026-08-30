/**
 * Posting to a Microsoft Teams incoming webhook.
 *
 * Teams takes an Adaptive Card wrapped in an attachment envelope. The older
 * MessageCard format is not used: Office 365 connectors are being retired and
 * the Workflows connector that replaces them expects this shape, so writing the
 * old one would produce webhooks that work today and stop.
 *
 * Everything that builds a card is pure and separate from everything that
 * sends one, because the cards are the part worth testing and the sending is
 * one fetch.
 */

export interface CardLink {
  title: string;
  url: string;
  /** A line under the title: repository, who is waiting, how long it has sat. */
  detail?: string;
}

export interface CardSection {
  heading: string;
  links: CardLink[];
  /** Shown in place of the list when there is nothing in it. */
  emptyText?: string;
}

/**
 * One card, built from sections.
 *
 * Titles are carried as text rather than markdown links inside a paragraph:
 * a pull request title can contain brackets and parentheses, and interpolating
 * one into `[title](url)` produces a broken link on exactly the pull requests
 * whose titles are most worth reading.
 */
export function buildCard(title: string, subtitle: string, sections: CardSection[]): any {
  const body: any[] = [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
    { type: "TextBlock", text: subtitle, isSubtle: true, spacing: "None", wrap: true },
  ];

  for (const section of sections) {
    // A blank heading is skipped rather than rendered: an empty bold TextBlock
    // draws a separator rule with nothing above it, which reads as a rendering
    // fault. Used by the plain-text path, which has a subject and a body and no
    // section names.
    if (section.heading) {
      body.push({
        type: "TextBlock", text: section.heading, weight: "Bolder",
        spacing: "Medium", separator: true, wrap: true,
      });
    }
    if (section.links.length === 0) {
      body.push({ type: "TextBlock", text: section.emptyText ?? "Nothing.", isSubtle: true, wrap: true });
      continue;
    }
    for (const link of section.links) {
      body.push({
        type: "TextBlock",
        // The title is a link; the detail is not. Teams renders this safely
        // because the URL is ours and the title is escaped below.
        text: `[${escapeMd(link.title)}](${link.url})`,
        wrap: true, spacing: "Small",
      });
      if (link.detail) {
        body.push({ type: "TextBlock", text: link.detail, isSubtle: true, size: "Small", spacing: "None", wrap: true });
      }
    }
  }

  return {
    type: "message",
    /**
     * What the toast says before anybody opens it.
     *
     * Without this Teams shows "sent a card", which tells a person nothing
     * about whether it is worth switching to. A notification that cannot be
     * triaged from the preview is a notification people learn to swipe away,
     * which defeats the whole point of sending one.
     *
     * `summary` is the message-level preview; `speak` is the card's own, used
     * by screen readers and by some clients for the same purpose. Both carry
     * the title and the lead, because which one a given Teams client reads is
     * not something worth guessing at.
     */
    summary: `${title}: ${subtitle}`,
    /**
     * The same content as text, for a flow using the message action instead of
     * the card one. Ignored by a flow that reads the card, so both work.
     */
    message: buildHtml(title, subtitle, sections),
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        speak: `${title}. ${subtitle}`,
        body,
      },
    }],
  };
}

/**
 * The same message as HTML, for the action that takes text.
 *
 * Teams builds a notification's preview from the message body, and a card has
 * no body: "Post card in a chat or channel" produces a toast reading "sent a
 * card" whatever the card contains. Nothing inside the card changes that, and
 * neither of the action's advanced parameters is text.
 *
 * So both renderings travel in every payload and the flow decides which it
 * reads. Switching between them is a change to one field in Power Automate
 * rather than a redeploy here, and a flow still on the card action keeps
 * working untouched.
 *
 * The title leads, because the first words are what a person sees on a lock
 * screen and all they have to decide whether to switch applications.
 */
export function buildHtml(title: string, subtitle: string, sections: CardSection[]): string {
  const out: string[] = [`<b>${escapeHtml(title)}</b>`];
  if (subtitle) out.push(escapeHtml(subtitle));

  for (const section of sections) {
    if (section.heading) out.push(`<br><b>${escapeHtml(section.heading)}</b>`);
    if (section.links.length === 0) {
      if (section.emptyText) out.push(escapeHtml(section.emptyText));
      continue;
    }
    for (const link of section.links) {
      // The URL is ours; the title is somebody's pull request and is escaped.
      out.push(`<a href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a>`
        + (link.detail ? `<br>${escapeHtml(link.detail)}` : ""));
    }
  }
  return out.join("<br>");
}

/**
 * Everything that could close a tag or open an attribute.
 *
 * Pull request titles are written by people and routinely contain angle
 * brackets and ampersands. Interpolated raw they would at best break the
 * message and at worst put markup of somebody else's choosing into a chat.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Markdown characters that would break a link label.
 *
 * A title containing `]` ends the label early and leaves the rest of it as
 * loose text beside a broken link, and titles containing brackets are common
 * ("[WIP] Fix the thing").
 */
export function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]()])/g, "\\$1");
}

export interface SendResult {
  ok: boolean;
  /** Present when it failed, in words somebody can act on. */
  error?: string;
  /**
   * What Teams answered.
   *
   * Power Automate replies 202 before it runs the flow, so a 202 means the
   * request was queued and says nothing about whether a message appeared. The
   * caller needs the difference: reporting "sent" on a queued request is how a
   * misconfigured flow looks like a working one.
   */
  status?: number;
  /** True for 202, where the outcome is genuinely not known yet. */
  queued?: boolean;
}

/**
 * Send a card to one person, through the organization's shared flow.
 *
 * The flow reads `recipient` and `card` out of the body: the destination
 * travels with the message rather than being frozen into the flow, which is
 * what lets one flow serve everybody instead of one per person.
 *
 * The card goes as a **string**, not an object. Power Automate's "Adaptive
 * Card" field is a text field, so a string can be bound straight from the
 * dynamic-content picker, while an object needs an expression somebody has to
 * type correctly. The setup instructions are the product here, and every
 * expression removed from them is a way it cannot be got wrong.
 */
export async function sendToPerson(
  flowUrl: string, recipient: string, card: any, timeoutMs = 8000,
): Promise<SendResult> {
  // The ordinary Teams envelope, with `recipient` added beside it.
  //
  // Not a payload of our own invention, and that is the whole point. The Teams
  // "webhook request received" trigger has a fixed schema with nowhere to
  // declare extra fields, so a body it does not recognise is a body it may
  // refuse. Sending the shape it already expects, plus one extra key, means the
  // trigger sees exactly what it always saw and the card binding the template
  // wrote for itself keeps working.
  //
  // What that buys is the setup: one field to change instead of three, and no
  // JSON schema to paste into a box that does not exist on this trigger.
  return post(flowUrl, { ...card, recipient }, timeoutMs);
}

/**
 * Post a body, and say plainly whether it arrived.
 *
 * Never throws. A notification that fails must not take down the pass that
 * sent it, one person's bad address would otherwise stop everybody else's
 * digest, so the failure is returned and recorded against that person alone.
 */
export async function post(webhookUrl: string, body: any, timeoutMs = 8000): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 4xx here is almost always a webhook that was deleted or regenerated in
      // Teams, which is the failure people cannot otherwise see.
      return {
        ok: false,
        error: res.status === 404 || res.status === 410
          ? "Power Automate no longer recognises this flow. It was probably deleted or its URL regenerated, so an administrator needs to set a new one."
          : `Power Automate refused the message (HTTP ${res.status}).`,
      };
    }
    return { ok: true, status: res.status, queued: res.status === 202 };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.name === "AbortError"
        ? "Power Automate did not answer in time."
        : `Could not reach Power Automate: ${err?.message ?? "unknown error"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
