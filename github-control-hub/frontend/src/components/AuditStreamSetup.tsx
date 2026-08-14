import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiDelete } from "../api/client";
import { usePermissions } from "../hooks/usePermissions";

interface AuditStreamStatus {
  configured: boolean;
  enterprise: string | null;
  roleArn: string | null;
  bucket: string;
  receiving: boolean;
  objectCount: number;
}

const inputClass =
  "block w-full rounded-md border-gh-border dark:border-slate-700 shadow-sm focus:border-gh-blue " +
  "focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset " +
  "ring-gray-300 dark:ring-slate-600 outline-none dark:bg-slate-800 dark:text-slate-200";

function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2">
      <div className="text-xs font-semibold text-gray-500 dark:text-slate-400">{label}</div>
      <div className="flex items-center gap-2 mt-0.5">
        <code className="flex-1 text-xs px-2 py-1.5 rounded bg-black/5 dark:bg-white/10 break-all text-left">
          {value}
        </code>
        <button
          onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="shrink-0 px-2 py-1 text-xs font-semibold rounded border border-gh-border dark:border-slate-600 hover:bg-black/5 dark:hover:bg-white/5">
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * Setting up enterprise audit-log streaming, from the page it fills.
 *
 * Three states worth telling apart, and the reason this lives here rather than
 * in a deploy flag: only the app can see the third one. AWS can be perfectly
 * configured while streaming is still switched off in GitHub, and a deploy has
 * no way to know that — it can only report what it created.
 */
export default function AuditStreamSetup() {
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;
  const qc = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: ["audit-stream"],
    queryFn: () => apiGet<AuditStreamStatus>("/activity/audit-stream"),
    enabled: isAdmin,
    refetchInterval: 30_000,
  });

  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);

  const disconnect = useMutation({
    mutationFn: () => apiDelete<{ removedRole: boolean; objectsKept: number }>("/activity/audit-stream"),
    onSuccess: () => { setError(""); setConfirmOff(false); qc.invalidateQueries({ queryKey: ["audit-stream"] }); },
    onError: (e: any) => setError(e?.message || "Could not turn it off."),
  });

  const setup = useMutation({
    mutationFn: (enterprise: string) =>
      apiPost<AuditStreamStatus>("/activity/audit-stream", { enterprise }),
    onSuccess: () => { setError(""); qc.invalidateQueries({ queryKey: ["audit-stream"] }); },
    onError: (e: any) => setError(e?.message || "Could not set that up."),
  });

  if (!isAdmin) {
    return (
      <>
        <p className="font-semibold text-slate-700 dark:text-slate-200">Enterprise audit log not connected</p>
        <p className="text-sm mt-1 max-w-md mx-auto">
          An organization admin can connect it. This stream stays empty until they do.
        </p>
      </>
    );
  }

  if (isLoading) return <p className="text-sm">Checking…</p>;

  const OffSwitch = () => confirmOff ? (
    <div className="mt-4 rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
      <p>
        This deletes the role GitHub assumes, so no new batches arrive. <strong>The archive is
        kept</strong> — the bucket and everything already collected stay exactly as they are, and
        objects still expire on their own after 400 days.
      </p>
      <p className="mt-1 text-xs">
        GitHub's own streaming switch is left alone; it will simply fail to deliver. Turning this
        back on later restores it.
      </p>
      <div className="flex gap-2 mt-3">
        <button onClick={() => disconnect.mutate()} disabled={disconnect.isPending}
          className="px-3 py-1.5 text-xs font-semibold rounded-md bg-red-600 text-white hover:opacity-90 disabled:opacity-50">
          {disconnect.isPending ? "Turning off…" : "Turn off streaming"}
        </button>
        <button onClick={() => setConfirmOff(false)}
          className="px-3 py-1.5 text-xs font-semibold rounded-md border border-gh-border dark:border-slate-600">
          Cancel
        </button>
      </div>
    </div>
  ) : (
    <button onClick={() => setConfirmOff(true)}
      className="mt-4 text-xs font-semibold text-red-600 dark:text-red-400 hover:underline">
      Turn off streaming
    </button>
  );

  // Set up in AWS, and objects are arriving. Nothing left to do.
  if (status?.configured && status.receiving) {
    return (
      <>
        <p className="font-semibold text-slate-700 dark:text-slate-200">Connected</p>
        <p className="text-sm mt-1 max-w-md mx-auto">
          Streaming from <strong>{status.enterprise}</strong>. {status.objectCount}+ batches
          delivered. Rows appear here as GitHub writes them — expect minutes, not seconds.
        </p>
        <OffSwitch />
      </>
    );
  }

  // The state a deploy cannot detect: AWS is ready, GitHub is not sending.
  if (status?.configured) {
    return (
      <div className="max-w-xl mx-auto text-left">
        <p className="font-semibold text-slate-700 dark:text-slate-200 text-center">
          AWS is ready — waiting on GitHub
        </p>
        <p className="text-sm mt-2 text-center">
          The role exists and trusts <strong>{status.enterprise}</strong>, but nothing has arrived
          yet. An enterprise owner has to switch streaming on, once, in a browser:
        </p>
        <p className="text-sm mt-3 font-semibold">
          Enterprise settings → Audit log → Streaming → Amazon S3
        </p>
        <Copyable label="Bucket" value={status.bucket} />
        <Copyable label="Role ARN" value={status.roleArn ?? ""} />
        <p className="text-xs mt-3 text-gray-500 dark:text-slate-400">
          Choose <strong>OpenID Connect</strong> as the authentication method. GitHub sends a test
          event on save; if it succeeds, batches start arriving and this page fills in.
        </p>
        <details className="mt-4">
          <summary className="text-xs font-semibold cursor-pointer text-gh-blue">
            Point it at a different enterprise
          </summary>
          <div className="flex gap-2 mt-2">
            <input value={slug} onChange={e => setSlug(e.target.value)}
              placeholder={status.enterprise ?? "enterprise-slug"} className={inputClass} />
            <button onClick={() => setup.mutate(slug)} disabled={!slug.trim() || setup.isPending}
              className="shrink-0 px-3 py-2 text-sm font-semibold rounded-md bg-gh-blue text-white hover:opacity-90 disabled:opacity-50">
              Update
            </button>
          </div>
        </details>
        <OffSwitch />
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  // Nothing set up at all.
  return (
    <div className="max-w-xl mx-auto text-left">
      <p className="font-semibold text-slate-700 dark:text-slate-200 text-center">
        Enterprise audit log not connected
      </p>
      <p className="text-sm mt-2 text-center">
        GitHub can stream your enterprise's audit log into this account, and it appears here.
        Setting it up creates two things in AWS: an OIDC provider for GitHub's audit-log issuer,
        and a role that may write to one bucket and nothing else.
      </p>
      <div className="flex gap-2 mt-4">
        <input value={slug} onChange={e => setSlug(e.target.value)}
          placeholder="enterprise slug" className={inputClass} />
        <button onClick={() => setup.mutate(slug)} disabled={!slug.trim() || setup.isPending}
          className="shrink-0 px-4 py-2 text-sm font-semibold rounded-md bg-gh-blue text-white hover:opacity-90 disabled:opacity-50">
          {setup.isPending ? "Setting up…" : "Set up"}
        </button>
      </div>
      <p className="text-xs mt-2 text-gray-500 dark:text-slate-400">
        The slug is the name in <code>github.com/enterprises/&lt;name&gt;</code>. Copy it exactly —
        it goes into an IAM trust policy, which unlike GitHub is fussy about case.
      </p>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
