import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAwsProfiles, useAwsProfile, triggerAwsSsoLogin, fetchAuthStatus, AwsProfile } from "../api/auth";

/**
 * Moving between AWS accounts without ending the GitHub session.
 *
 * The app used to be signed into one account for the life of a launch. Reaching
 * another meant going back to the login screen, and the switch invalidated the
 * session on the way — `JWT_SECRET` is read from each account's secret, so the
 * token minted under the last account stopped verifying the moment the new
 * one's secrets loaded. Changing which AWS account you were looking at
 * therefore signed you out of GitHub, which is not a thing anybody asked for.
 *
 * The session is now re-signed by the switch endpoint and adopted by the API
 * layer, so the identity survives. That matters beyond convenience: whether you
 * may run a sweep is decided by your membership of `aws-guardrail-admins`, and
 * that question is asked in every account, including the ones holding no GitHub
 * credentials at all.
 *
 * What the account has decides what the app shows. Switching into an account
 * whose secret holds nothing GitHub-shaped leaves the AWS and Activity tabs and
 * takes the rest away, which is the same state as signing in there would give.
 */
export default function AwsAccountSwitcher({ current, onSwitched }: {
  /** The profile in use, from /auth/status. */
  current?: string;
  /** Called after a switch lands, so the surrounding menu can close. */
  onSwitched?: () => void;
}) {
  const qc = useQueryClient();
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

      // Everything on screen belongs to the account we just left — findings,
      // activity, guardrails, the lot. Removing the queries rather than
      // invalidating them means no view can paint the old account's data while
      // the new account's request is still in the air.
      qc.removeQueries({
        // Everything except the profile list, which is read from this machine's
        // ~/.aws/config and belongs to neither account.
        predicate: q => !(q.queryKey[0] === "aws" && q.queryKey[1] === "profiles"),
      });
      await qc.fetchQuery({ queryKey: ["auth", "status"], queryFn: fetchAuthStatus });
      onSwitched?.();
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
    <div className="border-t border-slate-100 dark:border-white/[0.07]">
      <p className="px-4 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.16em] font-bold text-slate-400 dark:text-white/35">
        AWS account
      </p>

      {isLoading && (
        <p className="px-4 pb-3 text-[12px] text-slate-400 dark:text-white/40">Reading your profiles…</p>
      )}

      {error && (
        <p className="px-4 pb-3 text-[12px] text-slate-500 dark:text-white/50">
          Could not read <code className="text-[11px]">~/.aws/config</code>. Switch from the sign-in screen instead.
        </p>
      )}

      {profiles?.length === 0 && !isLoading && (
        <p className="px-4 pb-3 text-[12px] text-slate-500 dark:text-white/50">
          No named profiles found in <code className="text-[11px]">~/.aws/config</code>.
        </p>
      )}

      <div className="max-h-56 overflow-y-auto pb-1">
        {profiles?.map(profile => {
          const on = profile.name === current;
          return (
            <button
              key={profile.name}
              role="menuitem"
              disabled={on || busy !== null}
              onClick={() => switchTo(profile)}
              className={`w-full px-4 py-2.5 flex items-center gap-2.5 text-left transition-colors ${
                on
                  ? "bg-slate-50 dark:bg-white/[0.04] cursor-default"
                  : "hover:bg-slate-50 dark:hover:bg-white/[0.05] disabled:opacity-50"}`}>
              <i className={`ph-bold ${
                busy === profile.name ? "ph-spinner animate-spin"
                  : on ? "ph-check-circle text-emerald-500"
                  : "ph-cloud text-slate-400 dark:text-white/40"} text-base shrink-0`}></i>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-bold text-slate-900 dark:text-white truncate">
                  {profile.name}
                </span>
                {/* The account id is what people actually recognise, and it is
                    the thing that disambiguates two profiles into the same
                    account. Shown when the profile carries one. */}
                <span className="block text-[11px] text-slate-400 dark:text-white/40 truncate">
                  {profile.accountId || profile.type.toUpperCase()}
                  {on && " · in use"}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {problem && (
        <div className="px-4 py-3 border-t border-slate-100 dark:border-white/[0.07] bg-amber-50/60 dark:bg-amber-500/[0.07]">
          <p className="text-[12px] font-bold text-amber-800 dark:text-amber-300">
            {problem.profile} could not be reached
          </p>
          <p className="text-[11px] text-amber-700/80 dark:text-amber-200/70 mt-0.5 break-words">
            {problem.message}
          </p>
          {problem.sso && (
            <button
              onClick={() => { void triggerAwsSsoLogin(problem.profile); }}
              className="mt-2 text-[12px] font-bold text-amber-900 dark:text-amber-200 underline underline-offset-2">
              Sign in to SSO for this profile
            </button>
          )}
        </div>
      )}
    </div>
  );
}
