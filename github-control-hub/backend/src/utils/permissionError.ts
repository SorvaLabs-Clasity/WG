import { Response } from "express";

/**
 * A GitHub 403/404 on a write means the signed-in user lacks the permission for
 * that action on that repository. Because those calls are made with the user's
 * own token, GitHub's answer IS the authorization decision — this only turns it
 * into something readable.
 *
 * GitHub returns 404 rather than 403 when the user cannot see the resource at
 * all, so both map to the same message; distinguishing them would leak whether
 * a private repository exists.
 */
export function isPermissionDenied(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 403 || status === 404;
}

export function permissionMessage(login: string, action: string, repo?: string): string {
  const target = repo ? `"${repo}"` : "this organization";
  return `${login} does not have permission to ${action} on ${target}. ` +
    `The Control Hub acts with your own GitHub access, so you can only change what you could change directly on GitHub. ` +
    `Ask an admin of ${target} for access.`;
}

/** Send a 403 describing what was denied. Returns true when it handled the error. */
export function sendIfPermissionDenied(
  res: Response, err: unknown, login: string, action: string, repo?: string
): boolean {
  if (!isPermissionDenied(err)) return false;
  res.status(403).json({
    error: permissionMessage(login, action, repo),
    code: "GITHUB_PERMISSION_DENIED",
    repo,
  });
  return true;
}
