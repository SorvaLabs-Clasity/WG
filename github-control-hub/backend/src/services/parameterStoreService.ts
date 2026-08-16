import type { ParameterReader } from "./iacParseService";

/**
 * Reading a declared value out of SSM Parameter Store.
 *
 * Used only by drift, and only for values the file itself does not contain.
 * `GetParameter` is free and read-only, and it runs with the operator's own
 * credentials like everything else here.
 *
 * ## What it refuses to read
 *
 * **A SecureString.** Decrypting a secret so a drift panel can print it would
 * put it on screen, in an HTTP response and in whatever logs sit between —
 * permanently, for a comparison. The rule stays unresolved instead, which is
 * the honest outcome: the value exists and this deliberately did not look.
 *
 * That refusal is not a matter of permissions. `WithDecryption` is simply never
 * asked for, so even an operator who could decrypt the parameter does not do so
 * through this path.
 */

/** Cached per process: a parameter referenced by five rules is read once. */
const cache = new Map<string, string | null>();

export function __resetParameterCacheForTests(): void {
  cache.clear();
}

export function ssmReader(): ParameterReader {
  return async (name: string) => {
    if (cache.has(name)) return cache.get(name)!;

    let value: string | null = null;
    try {
      const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
      const { awsRegion } = await import("../utils/region");
      const client = new SSMClient({ region: awsRegion() });
      const r: any = await client.send(new GetParameterCommand({
        Name: name,
        // Never decrypted. See the note above — this is the line that keeps a
        // secret off the screen.
        WithDecryption: false,
      }));
      // A SecureString read without decryption comes back as ciphertext, which
      // is not a value and must not be compared against anything.
      value = r?.Parameter?.Type === "SecureString" ? null : (r?.Parameter?.Value ?? null);
    } catch {
      // Gone, denied, wrong account, wrong region. All the same answer here:
      // the value could not be read, so the rule stays unresolved. A missing
      // parameter is not an empty CIDR.
      value = null;
    }

    cache.set(name, value);
    return value;
  };
}
