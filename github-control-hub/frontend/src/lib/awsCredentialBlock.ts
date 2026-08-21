/**
 * The credentials block, in whichever shape AWS handed it over.
 *
 * The access portal's "Command line or programmatic access" dialog offers
 * four, and this used to require the literal word `export` — so the bash one
 * worked and the other three parsed to nothing at all. Combined with a button
 * that returned silently when nothing parsed, pasting the wrong-but-perfectly-
 * valid format did nothing whatsoever and said nothing about why:
 *
 *   export AWS_ACCESS_KEY_ID="ASIA..."      bash / zsh
 *   set AWS_ACCESS_KEY_ID=ASIA...           Windows command prompt
 *   $Env:AWS_ACCESS_KEY_ID="ASIA..."        PowerShell
 *   aws_access_key_id=ASIA...               credentials-file profile
 *
 * Line-based rather than one regex, because the shapes differ in prefix,
 * quoting and case, and a regex covering all four is unreadable and untestable.
 * Splitting on the *first* `=` matters: session tokens are base64 and routinely
 * end in `=`.
 */
export function parseExportBlock(block: string): Record<string, string> {
  // The credentials-file spellings, which are lower case and unprefixed.
  const aliases: Record<string, string> = {
    aws_access_key_id: "AWS_ACCESS_KEY_ID",
    aws_secret_access_key: "AWS_SECRET_ACCESS_KEY",
    aws_session_token: "AWS_SESSION_TOKEN",
    aws_default_region: "AWS_DEFAULT_REGION",
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
