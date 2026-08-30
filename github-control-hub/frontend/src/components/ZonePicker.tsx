import { useMemo } from "react";
import { allZones, zoneLabel, zoneShort } from "../lib/zones";

/**
 * An IANA timezone, chosen rather than typed.
 *
 * Typed, there is one correct spelling and no feedback: "EST" and "New York"
 * are not zones, and an unrecognised one is not rejected anywhere downstream.
 * It renders as UTC, and the only symptom is a timestamp quietly hours out,
 * which is the failure this control exists to end.
 *
 * Options read "EDT · GMT-4 · New York": the code the message will actually
 * say, then how far that is from anywhere else, then which one it is.
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
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const id of allZones(value)) {
      const [region, ...rest] = id.split("/");
      const key = rest.length ? region : "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ id, label: zoneLabel(id) });
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [value]);

  return (
    <select
      value={value ?? ""} disabled={disabled}
      onChange={e => onChange(e.target.value)}
      // The chosen zone shows as its code alone, because a row has no width for
      // three parts and the code is the half somebody is checking.
      title={value ? zoneLabel(value) : inherit}
      className={`text-[11.5px] py-0.5 pl-1.5 pr-5 rounded-md bg-transparent
                  border border-slate-200 dark:border-white/10
                  text-slate-500 dark:text-slate-400 max-w-[11rem] truncate
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

export { zoneShort };
