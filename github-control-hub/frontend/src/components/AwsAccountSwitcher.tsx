import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAwsProfiles, useAwsProfile, triggerAwsSsoLogin, AwsProfile } from "../api/auth";

/**
 * Moving between AWS accounts without ending the GitHub session.
 *
 * `JWT_SECRET` is read from each account's secret, so a token minted under one
 * account stops verifying the moment another's secrets load. The switch
 * endpoint re-signs the session and the API layer adopts it, so the identity
 * survives. That matters beyond convenience: whether you may run a sweep is
 * decided by your membership of `aws-guardrail-admins`, and that is asked in
 * every account, including ones holding no GitHub credentials.
 *
 * What the account holds decides what the app shows. Switching into one with
 * nothing GitHub-shaped leaves the AWS, Alarms and Activity tabs and takes the
 * rest away.
 */
export default function AwsAccountSwitcher({ current, onSwitched }: {
  /** The profile in use, from /auth/status. */
  current?: string;
  /** Called after a switch lands, so the surrounding menu can close. */
  onSwitched?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ profile: string; message: string; sso: boolean } | null>(null);

  // Read when the menu opens rather than on every render of the navbar: this
  // shells out to read ~/.aws/config, and nobody switches accounts often
  // enough to justify holding it.
  const { data: profiles, isLoading, error } = useQuery({
    queryKey: ["aws", "profiles"],
    queryFn: fetchAwsProfiles,
    staleTime: 30_000,
    retry: false,
  });

  const switchTo = async (profile: AwsProfile) => {
    setBusy(profile.name);
    setProblem(null);
    try {
      const result = await useAwsProfile(profile.name);

      // Reachable is the honest answer to "did that work", and it is false for
      // the ordinary case of an SSO profile whose session has expired. Saying
      // so and offering the login beats a switch that silently did nothing.
      if (!result.reachable) {
        setProblem({
          profile: profile.name,
          message: result.error || "That account could not be reached.",
          sso: profile.type === "sso",
        });
        return;
      }

      // Reload, rather than invalidate.
      //
      // Clearing the query cache was the first attempt and it was not enough:
      // every mounted page also holds state of its own, a selected stream, an
      // expanded row, a filter, a page number, and all of it describes the
      // account being left. The Activity tab kept its GitHub stream selected
      // until it was navigated away from and back, which is the same bug
      // wearing a different hat.
      //
      // A switch is rare, deliberate, and means "show me somewhere else
      // entirely". Reloading gives exactly the state that signing in to that
      // account would, and no view can be left holding a stale half of the
      // other one. The session is in sessionStorage and survives it, which is
      // what makes this a reload rather than a sign-out.
      onSwitched?.();
      window.location.reload();
    } catch (err) {
      setProblem({
        profile: profile.name,
        message: (err as Error).message || "The switch failed.",
        sso: profile.type === "sso",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-t border-slate-100 dark:border-ink/[0.07]">
      {/* Region is named here because it is half of what a row identifies.
          One installation per region means two profiles can be the same
          account and hold entirely different rules, findings and alarms, and
          a heading saying only "AWS account" invites reading them as
          duplicates. */}
      <p className="caps px-4 pt-3 pb-1.5">
        AWS account and region
      </p>

      {isLoading && (
        <p className="px-4 pb-3 text-[0.75rem] text-slate-400 dark:text-ink/40">Reading your profiles…</p>
      )}

      {error && (
        <p className="px-4 pb-3 text-[0.75rem] text-slate-500 dark:text-ink/50">
          Could not read <code className="text-[0.6875rem]">~/.aws/config</code>. Switch from the sign-in screen instead.
        </p>
      )}

      {profiles?.length === 0 && !isLoading && (
        <p className="px-4 pb-3 text-[0.75rem] text-slate-500 dark:text-ink/50">
          No named profiles found in <code className="text-[0.6875rem]">~/.aws/config</code>.
        </p>
      )}

      <div className="max-h-56 overflow-y-auto pb-1">
        {profiles?.map(profile => {
          const on = profile.name === current;
          return (
            <button
              key={profile.name}
              role="menuitem"
              aria-current={on ? "true" : undefined}
              title={on ? `${profile.name} is in use` : `Switch to ${profile.name}`}
              disabled={on || busy !== null}
              onClick={() => switchTo(profile)}
              className={`w-full px-4 py-2.5 flex items-center gap-2.5 text-left transition-colors ${
                on
                  ? "bg-slate-50 dark:bg-ink/[0.04] cursor-default"
                  : "hover:bg-slate-50 dark:hover:bg-ink/[0.05] disabled:opacity-50"}`}>
              <i className={`ph-bold ${
                busy === profile.name ? "ph-spinner animate-spin"
                  : on ? "ph-check-circle text-emerald-500"
                  : "ph-cloud text-slate-400 dark:text-ink/40"} text-base shrink-0`}></i>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.8125rem] font-bold text-slate-900 dark:text-ink truncate">
                  {profile.name}
                </span>
                {/* The account id is what people recognise; the region is what
                    tells two profiles into the same account apart, and it used
                    to be fetched and then not shown, so a per-region pair
                    rendered as two identical rows.

                    A profile with no region of its own is called out rather
                    than left blank: it inherits whatever the SDK resolves,
                    which is the one case where what you get is not written
                    down anywhere on this screen. */}
                {/* Two facts, not three. The menu is 240px wide and this line
                    is truncated, so a third one pushed the region, the thing
                    that tells two profiles into the same account apart, off the
                    end as "· in…". The check icon to the left already says
                    which profile is in use, so the words did not need to. */}
                <span className="block text-[0.6875rem] text-slate-400 dark:text-ink/40 truncate">
                  {profile.accountId || profile.type.toUpperCase()}
                  {profile.region
                    ? ` · ${profile.region}`
                    : " · no region set"}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {problem && (
        <div className="px-4 py-3 border-t border-rule bg-ochre-wash">
          <p className="text-[0.75rem] font-bold text-amber-800 dark:text-amber-300">
            {problem.profile} could not be reached
          </p>
          <p className="text-[0.6875rem] text-amber-700/80 dark:text-amber-200/70 mt-0.5 break-words">
            {problem.message}
          </p>
          {problem.sso && (
            <button
              onClick={() => { void triggerAwsSsoLogin(problem.profile); }}
              className="textlink caps !text-ochre mt-2">
              Sign in to SSO for this profile
            </button>
          )}
        </div>
      )}
    </div>
  );
}
