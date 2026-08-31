/**
 * Naming a timezone the way the people reading it do: `EDT · GMT-4 · New York`.
 *
 * The code first, because it is what a notification says and what somebody is
 * scanning for. The offset next, because a code alone does not place it. The
 * city last, and it stays: without it, four hundred zones contain dozens of
 * rows reading "EDT · GMT-4", and picking the wrong one is right today and
 * wrong when a government changes its rules.
 *
 * Zones with no letter code, which is most of the world, lead with the offset
 * instead: `GMT+5:30 · Kolkata`.
 */

/** What a zone is called in a message: "EDT", or "" when it has no letters. */
export function zoneCode(timeZone: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value ?? "";
    // Most of the world has no abbreviation, and `short` gives the offset
    // instead. That is not a code, and treating it as one would print
    // "GMT+5:30 · GMT+5:30".
    return /^GMT[+-]/.test(name) || name === "" ? "" : name;
  } catch {
    return "";
  }
}

/** The current offset: "GMT-4", "GMT+5:30". */
export function zoneOffset(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** The city half of an IANA name, readable: "New York", "Sao Paulo". */
export function zoneCity(timeZone: string): string {
  return timeZone.split("/").slice(1).join("/").replace(/_/g, " ") || timeZone;
}

/** The full label for a list: "EDT · GMT-4 · New York". */
export function zoneLabel(timeZone: string): string {
  const code = zoneCode(timeZone);
  const offset = zoneOffset(timeZone);
  const city = zoneCity(timeZone);
  return [code, offset, city].filter(Boolean).join(" · ");
}

/** The short form, for a row that has no space: "EDT", else "GMT+5:30". */
export function zoneShort(timeZone: string): string {
  return zoneCode(timeZone) || zoneOffset(timeZone) || timeZone;
}

/** Every zone this runtime knows, plus `keep` so a stored one stays selectable. */
export function allZones(keep?: string): string[] {
  const all: string[] = (Intl as any).supportedValuesOf?.("timeZone") ?? [];
  return Array.from(new Set([...all, keep].filter(Boolean) as string[])).sort();
}
