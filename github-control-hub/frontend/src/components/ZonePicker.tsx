import { useMemo } from "react";

/**
 * An IANA timezone, chosen rather than typed.
 *
 * Typed, there is one correct spelling and no feedback: "EST" and "New York"
 * are not zones, and an unrecognised one is not rejected anywhere downstream.
 * It renders as UTC, and the only symptom is a timestamp quietly hours out,
 * which is the failure this control exists to end.
 *
 * The label shows the abbreviation people actually recognise (EDT, GMT+5:30)
 * beside the name, because that is what appears in the message.
 */
export default function ZonePicker({
  value, onChange, inherit, disabled, className = "",
}: {
  value?: string;
  onChange: (zone: string) => void;
  /** What an empty value falls back to, named so the default is not a blank. */
  inherit: string;
  disabled?: boolean;
  className?: string;
}) {
  const zones = useMemo(() => {
    const all: string[] = (Intl as any).supportedValuesOf?.("timeZone") ?? [];
    // Whatever is stored stays selectable even on a runtime that has not heard
    // of it, so opening this cannot silently change somebody's setting.
    const names = Array.from(new Set([...all, value].filter(Boolean) as string[])).sort();
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const id of names) {
      const [region, ...rest] = id.split("/");
      const key = rest.length ? region : "Other";
      const abbr = abbreviation(id);
      const label = `${rest.join("/").replace(/_/g, " ") || id}${abbr ? `  ${abbr}` : ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ id, label });
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [value]);

  return (
    <select
      value={value ?? ""} disabled={disabled}
      onChange={e => onChange(e.target.value)}
      className={`text-[11.5px] py-0.5 pl-1.5 pr-5 rounded-md bg-transparent
                  border border-slate-200 dark:border-white/10
                  text-slate-500 dark:text-slate-400 max-w-[10rem] truncate
                  disabled:opacity-40 ${className}`}
    >
      <option value="">{inherit}</option>
      {zones.map(([region, entries]) => (
        <optgroup key={region} label={region}>
          {entries.map(z => <option key={z.id} value={z.id}>{z.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * What a zone is called in a message: "EDT", "GMT+5:30".
 *
 * The same `timeZoneName: "short"` the message formatter uses, so what is shown
 * when choosing is what arrives in the email.
 */
export function abbreviation(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}
