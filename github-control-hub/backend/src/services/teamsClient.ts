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
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body,
      },
    }],
  };
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
}

/**
 * Post a card, and say plainly whether it arrived.
 *
 * Never throws. A notification that fails must not take down the pass that
 * sent it, one person's stale webhook would otherwise stop everybody else's
 * digest, so the failure is returned and recorded against that person alone.
 */
export async function sendCard(webhookUrl: string, card: any, timeoutMs = 8000): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 4xx here is almost always a webhook that was deleted or regenerated in
      // Teams, which is the failure people cannot otherwise see.
      return {
        ok: false,
        error: res.status === 404 || res.status === 410
          ? "Teams no longer recognises this webhook. It was probably deleted or regenerated, create a new one and paste it again."
          : `Teams refused the message (HTTP ${res.status}).`,
      };
    }
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.name === "AbortError"
        ? "Teams did not answer in time."
        : `Could not reach Teams: ${err?.message ?? "unknown error"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
