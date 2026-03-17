import { Request, Response, NextFunction } from "express";

// GitHub repo names: alphanumeric, hyphens, dots, underscores. Max 100 chars.
const REPO_NAME_RE = /^[a-zA-Z0-9._-]{1,100}$/;

// Branch names: no control chars, no space, no ~ ^ : ? * [ \, max 255 chars.
const BRANCH_NAME_RE = /^[^\x00-\x1f\x7f ~^:?*[\]\\]{1,255}$/;

export function isValidRepoName(name: string): boolean {
  return REPO_NAME_RE.test(name) && !name.startsWith(".") && !name.endsWith(".");
}

export function isValidBranchName(name: string): boolean {
  return BRANCH_NAME_RE.test(name) && !name.includes("..") && !name.endsWith(".lock");
}

/**
 * Express middleware factory that validates named route params.
 * Usage: router.get("/:repo/branches", validateParams("repo"), handler)
 */
export function validateParams(...paramNames: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const p of paramNames) {
      const raw = req.params[p];
      if (!raw) continue;
      const val = Array.isArray(raw) ? raw[0] : raw;
      if (p === "repo" && !isValidRepoName(val)) {
        res.status(400).json({ error: `Invalid repository name` });
        return;
      }
      if (p === "branch" && !isValidBranchName(val)) {
        res.status(400).json({ error: `Invalid branch name` });
        return;
      }
    }
    next();
  };
}
