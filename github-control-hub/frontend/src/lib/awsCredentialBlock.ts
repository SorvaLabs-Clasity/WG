/**
 * The credentials block, in whichever shape AWS handed it over.
 *
 * The access portal's "Command line or programmatic access" dialog offers four,
 * and accepting only one means pasting a perfectly valid block does nothing:
 *
 *   export AWS_ACCESS_KEY_ID="ASIA..."      bash / zsh
 *   set AWS_ACCESS_KEY_ID=ASIA...           Windows command prompt
 *   $Env:AWS_ACCESS_KEY_ID="ASIA..."        PowerShell
 *   aws_access_key_id=ASIA...               credentials-file profile
 *
 * Line-based rather than one regex, because the shapes differ in prefix,
 * quoting and case, and a regex covering all four is unreadable and untestable.
 * Split on the *first* `=`: session tokens are base64 and routinely end in `=`.
 */
export function parseExportBlock(block: string): Record<string, string> {
  // The credentials-file spellings, which are lower case and unprefixed.
  const aliases: Record<string, string> = {
    aws_access_key_id: "AWS_ACCESS_KEY_ID",
    aws_secret_access_key: "AWS_SECRET_ACCESS_KEY",
    aws_session_token: "AWS_SESSION_TOKEN",
    aws_default_region: "AWS_DEFAULT_REGION",
    aws_region: "AWS_DEFAULT_REGION",
    region: "AWS_DEFAULT_REGION",
  };
  const unquote = (v: string) => v.replace(/^["']|["']$/g, "");
  const vals: Record<string, string> = {};

  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    // `[123456789012_AdministratorAccess]` is the profile header, not a value.
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;

    const bare = line.replace(/^(?:export|set|setx)\s+/i, "").replace(/^\$Env:/i, "");
    const eq = bare.indexOf("=");
    if (eq < 0) continue;

    const key = unquote(bare.slice(0, eq).trim());
    const value = unquote(bare.slice(eq + 1).trim());
    if (!key || !value) continue;

    const name = aliases[key.toLowerCase()]
      ?? (/^AWS_/i.test(key) ? key.toUpperCase() : "");
    if (name) vals[name] = value;
  }
  return vals;
}

/**
 * The region a pasted block names, if it names one.
 *
 * Most do not. The access portal's "Command line or programmatic access" dialog
 * gives the key id, the secret and the session token and stops — which is why
 * the paste form needs a region field of its own rather than hoping to find one
 * here. A block copied out of a credentials file does carry `region`, and that
 * is worth not making somebody retype.
 *
 * Every spelling folds onto AWS_DEFAULT_REGION in `parseExportBlock`, so this
 * is one lookup rather than three.
 */
export function regionFromBlock(block: string): string {
  return parseExportBlock(block).AWS_DEFAULT_REGION ?? "";
}

/** The shape AWS regions have, for saying so before a round trip. */
export function looksLikeRegion(region: string): boolean {
  return /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region.trim());
}
