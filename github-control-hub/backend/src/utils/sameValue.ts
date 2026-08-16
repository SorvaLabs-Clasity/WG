/**
 * Whether two stored values mean the same thing.
 *
 * `JSON.stringify(a) === JSON.stringify(b)` is the obvious way to write this
 * and it is wrong, because it compares the order the keys happen to be in.
 * DynamoDB stores a map unordered and hands it back in whatever order it likes,
 * so a value written as
 *
 *     { kind, metric, op, threshold }
 *
 * came back as
 *
 *     { kind, threshold, metric, op }
 *
 * — the same condition, a different string. Anything asking "did this change?"
 * by comparing those two strings answers yes, every time, forever.
 *
 * That is not a cosmetic bug. An alarm's condition is compared this way to
 * decide whether to reset its ALARM/OK state, so every save of any field — a
 * rename, a typo fixed in the email body — looked like the condition had
 * changed, reset a firing alarm to OK, and made the next evaluation a fresh
 * breach that emailed everyone again.
 *
 * Compared structurally instead: key order is not information, and two objects
 * with the same keys and the same values are the same value.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // NaN is not === itself, and a stored NaN compared against a fresh one is the
  // same reading, not a change.
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }

  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const x = a as unknown[], y = b as unknown[];
    // Order *is* information in an array — a list of reviewers is not the same
    // list reversed — so this one is compared position by position.
    return x.length === y.length && x.every((v, i) => sameValue(v, y[i]));
  }

  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const xk = Object.keys(x), yk = Object.keys(y);
  if (xk.length !== yk.length) return false;
  // `hasOwnProperty` rather than `y[k] !== undefined`: a key explicitly set to
  // undefined is a different shape from a key that is absent, and treating them
  // as equal is how a cleared field reads as unchanged.
  return xk.every(k => Object.prototype.hasOwnProperty.call(y, k) && sameValue(x[k], y[k]));
}
