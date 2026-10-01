/**
 * What a card's answer is made of, as the permissions to read it.
 *
 * docs/auth/permissions-model.md, "Overview is not a side channel": a card on
 * the shared Overview, or on somebody's own board, shows another tab's data —
 * repository checks, vulnerabilities, Renovate's pull requests. Seeing the
 * board is not a way around those tabs' own reads, so a card whose data the
 * person may not read is **absent**: left out of the board and of the stored
 * answers, not drawn broken. The same reads decide whether somebody may make
 * such a card, or set an alarm on one, since an alarm's email carries its
 * numbers.
 *
 * Mirrored for the add-card form in frontend/src/lib/widgetPresets.ts
 * (CARD_READS); repro-cardreads.ts keeps the two in step.
 */

export interface CardShape {
  type: "preset" | "query" | string;
  presetId?: string;
}

/** Every permission needed to read what this card shows. */
export function cardReads(card: CardShape): string[] {
  if (card.type === "query") return ["repos.query.read"];
  switch (card.presetId) {
    case "dependabot":
    case "vuln-repos":
      return ["deps.read"];
    case "renovate-open":
      return ["deps.renovate.read"];
    case "bypasses":
      return ["repos.query.read"];
    default:
      // A preset this list does not know: the repository checks, the read
      // nearly every card is made of, rather than nothing.
      return ["repos.query.read"];
  }
}

/** Whether a person holding `has` may read this card. */
export function mayReadCard(card: CardShape, has: (key: string) => boolean): boolean {
  return cardReads(card).every(has);
}
