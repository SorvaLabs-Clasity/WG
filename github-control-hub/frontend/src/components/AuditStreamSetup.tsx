import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiDelete } from "../api/client";
import { usePermissions } from "../hooks/usePermissions";

interface SetupResult {
  roleArn: string;
  bucket: string;
  createdProvider: boolean;
  createdRole: boolean;
}

interface AuditStreamStatus {
  configured: boolean;
  enterprise: string | null;
  roleArn: string | null;
  bucket: string;
  receiving: boolean;
  objectCount: number;
  /** Checks that could not run. Empty means every one of them answered. */
  unknown: { what: "role" | "bucket"; reason: string }[];
  /** The account actually looked in — a wrong one is otherwise invisible. */
  accountId: string;
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
/**
 * The bordered card the setup states live in.
 *
 * It used to be wrapped around this component by the Activity page, which meant
 * it was drawn whether or not there was anything to say — a full-width panel
 * offering to connect a stream that had been connected for months. The chrome
 * belongs with the state that needs it, so the connected case can be a single
 * quiet line instead.
 */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 bg-white dark:bg-slate-900 rounded-lg border border-gh-border dark:border-slate-700 p-4 text-center">
      {children}
    </div>
  );
}

export default function AuditStreamSetup() {
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;
  const qc = useQueryClient();

  const { data: status, isLoading, error: statusError } = useQuery({
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

  /**
   * Returns what it created, and that is what the next screen is built from.
   *
   * Not the refetched status: IAM is eventually consistent, so a GetRole issued
   * straight after CreateRole can answer NoSuchEntity. Trusting the refetch
   * meant a successful setup could render as "not connected" and drop somebody
   * back to the form they had just completed, with no sign of the half still
   * left to do.
   */
  const setup = useMutation({
    mutationFn: (enterprise: string) =>
      apiPost<SetupResult>("/activity/audit-stream", { enterprise }),
    onSuccess: () => { setError(""); qc.invalidateQueries({ queryKey: ["audit-stream"] }); },
    onError: (e: any) => setError(e?.message || "Could not set that up."),
  });

  // Never asked, so it must not answer.
  //
  // This used to say "Enterprise audit log not connected" — a claim about the
  // stream, made by a branch that returns before the status is ever fetched.
  // On a working stream it told everyone who was not an admin that the thing
  // filling the table below them did not exist.
  if (!isAdmin) {
    return (
      <Panel><>
        <p className="font-semibold text-slate-700 dark:text-slate-200">Audit log streaming</p>
        <p className="text-sm mt-1 max-w-md mx-auto">
          Only organization admins can see or change the streaming setup. Rows appear
          here whenever it is switched on.
        </p>
      </></Panel>
    );
  }

  if (isLoading) return <Panel><p className="text-sm">Checking…</p></Panel>;

  // The request itself failed. Falling through from here rendered the setup
  // prompt, so a 403 or a network blip looked exactly like a stream that had
  // never been connected.
  if (statusError) {
    return (
      <Panel><>
        <p className="font-semibold text-slate-700 dark:text-slate-200">
          Could not check the streaming setup
        </p>
        <p className="text-sm mt-1 max-w-md mx-auto">
          {(statusError as Error).message}
        </p>
        <p className="text-xs mt-2 text-gray-500 dark:text-slate-400 max-w-md mx-auto">
          This says nothing about whether streaming is on — only that the check
          could not run. Any rows below arrived normally.
        </p>
      </></Panel>
    );
  }

  // The call worked but a check inside it did not. Same rule: an unknown is not
  // a no, and the reason is the whole of what makes it fixable.
  if (status?.unknown?.length) {
    const role = status.unknown.find(u => u.what === "role");
    return (
      <Panel><>
        <p className="font-semibold text-slate-700 dark:text-slate-200">
          Could not check the streaming setup
        </p>
        <p className="text-sm mt-1 max-w-md mx-auto">
          {role
            ? <>Looked for the role <strong>{status.bucket.replace(/-audit-log-\d+$/, "")}-audit-log-stream</strong> in
                account <strong>{status.accountId}</strong> and could not read it — {role.reason}.
                Usually a missing <code>iam:GetRole</code> permission, or the wrong account.</>
            : <>Could not list <strong>{status.bucket}</strong> — {status.unknown[0].reason}.</>}
        </p>
        <p className="text-xs mt-2 text-gray-500 dark:text-slate-400 max-w-md mx-auto">
          Streaming may well be running. Any rows below arrived normally.
        </p>
      </></Panel>
    );
  }

  /**
   * A quiet link, not a red panel wedged into the page.
   *
   * The inline version pushed the layout around every time it opened and put a
   * warning colour on a screen where nothing was wrong yet. Turning a stream
   * off is a deliberate act, so it asks in a dialog and gets out of the way.
   *
   * A plain call, not a nested component: declaring one inside a render makes it
   * a new type each time, so React rebuilds it instead of updating it — which
   * reset the "copied" tick on the values below whenever a poll landed.
   */
  const offSwitch = () => (
    <button onClick={() => setConfirmOff(true)}
      className="text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:underline">
      Turn off streaming
    </button>
  );

  const offDialog = () => !confirmOff ? null : (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in"
        onClick={() => setConfirmOff(false)} />
      <div className="bg-white dark:bg-slate-900 rounded-[12px] shadow-modal border border-black/10 dark:border-slate-700 w-full max-w-md relative z-10 animate-slide-up text-left">
        <div className="px-6 py-4 border-b border-gh-border dark:border-slate-700">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white tracking-tight">
            Turn off audit-log streaming?
          </h3>
        </div>
        <div className="px-6 py-5 space-y-3 text-sm text-gh-textBase dark:text-slate-300">
          <p>
            This deletes the role GitHub assumes, so no new batches arrive.
          </p>
          <p className="rounded-md bg-slate-50 dark:bg-white/[0.04] px-3 py-2">
            <strong>Everything already collected is kept.</strong> The bucket and its contents stay
            exactly as they are, and objects still expire on their own after 400 days.
          </p>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            GitHub's own streaming switch is left alone — it will simply fail to deliver. Setting
            this up again later restores it.
          </p>
        </div>
        <div className="px-6 py-4 border-t border-gh-border dark:border-slate-700 flex justify-end gap-2">
          <button onClick={() => setConfirmOff(false)}
            className="px-4 py-2 text-sm font-semibold rounded-md text-gh-textBase dark:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5">
            Cancel
          </button>
          <button onClick={() => disconnect.mutate()} disabled={disconnect.isPending}
            className="px-4 py-2 text-sm font-semibold rounded-md bg-red-600 text-white hover:opacity-90 disabled:opacity-50">
            {disconnect.isPending ? "Turning off…" : "Turn it off"}
          </button>
        </div>
      </div>
    </div>
  );

  const gitHubStep = (bucket: string, roleArn: string) => (
    <>
      <p className="text-sm mt-3 font-semibold">
        Enterprise settings → Audit log → Streaming → Amazon S3
      </p>
      <Copyable label="Bucket" value={bucket} />
      <Copyable label="Role ARN" value={roleArn} />
      <p className="text-xs mt-3 text-gray-500 dark:text-slate-400">
        Choose <strong>OpenID Connect</strong> as the authentication method. GitHub sends a test
        event on save; if it succeeds, batches start arriving and this page fills in.
      </p>
    </>
  );

  // Just set up. Built from what the call returned rather than from a refetch,
  // so the second half is shown even while IAM is still catching up.
  if (setup.isSuccess && setup.data) {
    return (
      <Panel><div className="max-w-xl mx-auto text-left">
        <p className="font-semibold text-green-700 dark:text-green-400 text-center">
          AWS side done — one step left, and it is not in this app
        </p>
        <p className="text-sm mt-2 text-center">
          The role exists and trusts your enterprise. Nothing will arrive until an
          <strong> enterprise owner</strong> switches streaming on in GitHub:
        </p>
        {gitHubStep(setup.data.bucket, setup.data.roleArn)}
        <button onClick={() => setup.reset()}
          className="mt-4 text-xs font-semibold text-gh-blue hover:underline">
          Done — check status
        </button>
      </div></Panel>
    );
  }

  /**
   * Working, and therefore almost silent.
   *
   * This was a full-width bordered panel announcing "Connected" above every row
   * on the page, permanently. A status that never changes is not information
   * after the first read; it is furniture. One line, and the details behind a
   * disclosure — which is also where the bucket and role ARN belong, since the
   * only times anybody wants them are re-creating a deleted stream, pointing a
   * second enterprise at the same bucket, or checking what GitHub was given.
   * All of those happen long after setup, and none of them are urgent.
   */
  if (status?.configured && status.receiving) {
    return (
      <details className="mb-4 group/stream">
        <summary className="flex items-center gap-2 cursor-pointer list-none px-1 py-1.5 text-xs text-gh-muted dark:text-slate-400 hover:text-gh-textBase dark:hover:text-slate-200 transition-colors">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
          <span>
            Streaming from{" "}
            <strong className="font-semibold text-gh-textBase dark:text-slate-200">{status.enterprise}</strong>
          </span>
          <span className="text-slate-400 dark:text-slate-500">· {status.objectCount}+ batches</span>
          <i className="ph-bold ph-caret-down text-[10px] ml-auto transition-transform group-open/stream:rotate-180" />
        </summary>

        <div className="mt-2 rounded-lg border border-gh-border dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-left">
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Rows appear as GitHub writes them — expect minutes, not seconds. These are what an
            enterprise owner entered at{" "}
            <strong>Enterprise settings → Audit log → Log streaming → Amazon S3</strong>,
            authenticating with <strong>OpenID Connect</strong>. Needed again only to re-create
            the stream if it is removed there.
          </p>
          <Copyable label="Bucket" value={status.bucket} />
          <Copyable label="Role ARN" value={status.roleArn ?? ""} />
          <div className="mt-3">{offSwitch()}</div>
        </div>
        {offDialog()}
      </details>
    );
  }

  // The state a deploy cannot detect: AWS is ready, GitHub is not sending.
  if (status?.configured) {
    return (
      <Panel><div className="max-w-xl mx-auto text-left">
        <p className="font-semibold text-slate-700 dark:text-slate-200 text-center">
          AWS is ready — waiting on GitHub
        </p>
        <p className="text-sm mt-2 text-center">
          The role exists and trusts <strong>{status.enterprise}</strong>, but nothing has arrived
          yet. An enterprise owner has to switch streaming on, once, in a browser:
        </p>
        {gitHubStep(status.bucket, status.roleArn ?? "")}
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
        <div className="mt-4">{offSwitch()}</div>
        {offDialog()}
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div></Panel>
    );
  }

  // Nothing set up at all.
  return (
    <Panel><div className="max-w-xl mx-auto text-left">
      <p className="font-semibold text-slate-700 dark:text-slate-200 text-center">
        Enterprise audit log not connected
      </p>
      <p className="text-sm mt-2 text-center">
        GitHub can stream your enterprise's audit log into this account, and it appears here.
      </p>
      <div className="mt-3 rounded-md bg-slate-50 dark:bg-white/[0.04] px-3 py-2 text-sm">
        <p className="font-semibold text-gh-textBase dark:text-slate-200">This takes two steps</p>
        <p className="mt-1 text-gray-600 dark:text-slate-400">
          <strong>1. Here.</strong> Creates an OIDC provider for GitHub's audit-log issuer and a
          role that may write to one bucket and nothing else.
        </p>
        <p className="mt-1 text-gray-600 dark:text-slate-400">
          <strong>2. In GitHub</strong>, by an enterprise owner — switching streaming on and
          pointing it at that bucket. This app cannot do that part, and nothing arrives until
          somebody does. You will get the bucket and role to paste once step 1 finishes.
        </p>
      </div>
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
    </div></Panel>
  );
}
