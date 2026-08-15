import { Router, Request, Response } from "express";
import { createOctokit } from "../github/client";

import { sanitizeError } from "../utils/errorSanitizer";
import {
  expertsForRepo, expertsForPath, expertsForLibrary, type GithubReader,
} from "../services/expertiseService";

const router = Router();

/**
 * Read with the caller's own token, not the app's.
 *
 * This answers "who has touched this", which is a question about a repository
 * the asker may not be allowed to see. Using the app's installation token would
 * let anyone with a login enumerate contributors on private repositories they
 * have no access to. GitHub already knows what each user may read, so the
 * token decides it and no permission logic is duplicated here.
 */
function readerFor(token: string, org: string): GithubReader {
  const octokit = createOctokit(token);
  const split = (repo: string) => {
    const [a, b] = repo.includes("/") ? repo.split("/") : [org, repo];
    return { owner: a, repo: b };
  };

  return {
    async listCommits(repo, path) {
      const { data } = await octokit.rest.repos.listCommits({
        ...split(repo), per_page: 100, ...(path ? { path } : {}),
      });
      return data.map((c: any) => ({
        // `author` is the linked GitHub account; `commit.author` is whatever
        // was in git config. Preferring the former keeps one person from
        // appearing three times under three spellings of their own name.
        login: c.author?.login ?? c.commit?.author?.name,
        at: c.commit?.author?.date ?? c.commit?.committer?.date,
      }));
    },
    async listReviewComments(repo) {
      const { data } = await octokit.rest.pulls.listReviewCommentsForRepo({
        ...split(repo), per_page: 100, sort: "created", direction: "desc",
      });
      return data.map((c: any) => ({ login: c.user?.login, at: c.created_at }));
    },
    async listIssueComments(repo) {
      const { data } = await octokit.rest.issues.listCommentsForRepo({
        ...split(repo), per_page: 100, sort: "created", direction: "desc",
      });
      return data.map((c: any) => ({ login: c.user?.login, at: c.created_at }));
    },
    async searchCode(q) {
      const { data } = await octokit.rest.search.code({ q, per_page: 50 });
      return (data.items ?? []).map((i: any) => ({
        repo: i.repository?.full_name ?? "", path: i.path ?? "",
      }));
    },
  };
}

const org = () => process.env.GITHUB_ORG || "";

/** The caller's own token, or null if the session carries none. */
function tokenOf(req: Request): string | null {
  return req.user?.accessToken || null;
}

/** Rejected rather than passed through: these are interpolated into a query. */
function badName(value: string): string | null {
  if (!value.trim()) return "A name is required";
  if (value.length > 200) return "That name is too long";
  return null;
}

router.get("/repo/:repo", async (req: Request<{ repo: string }>, res: Response) => {
  const repo = String(req.params.repo);
  const problem = badName(repo);
  if (problem) return res.status(400).json({ error: problem });
  const token = tokenOf(req);
  if (!token) return res.status(401).json({ error: "No GitHub token provided" });
  try {
    const result = await expertsForRepo(readerFor(token, org()), repo);
    res.json({ subject: { kind: "repo", name: repo }, ...result });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "expertise") });
  }
});

router.get("/path/:repo", async (req: Request<{ repo: string }>, res: Response) => {
  const repo = String(req.params.repo);
  const path = String(req.query.path ?? "");
  const problem = badName(repo) || badName(path);
  if (problem) return res.status(400).json({ error: problem });
  const token = tokenOf(req);
  if (!token) return res.status(401).json({ error: "No GitHub token provided" });
  try {
    const result = await expertsForPath(readerFor(token, org()), repo, path);
    res.json({ subject: { kind: "path", name: `${repo}/${path}` }, ...result });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "expertise") });
  }
});

router.get("/library/:name", async (req: Request<{ name: string }>, res: Response) => {
  const name = String(req.params.name);
  const problem = badName(name);
  if (problem) return res.status(400).json({ error: problem });

  // A quote would escape the quoted search term and change the query into
  // something else entirely. Refused rather than stripped, so a search that
  // cannot mean what was typed reports itself instead of answering wrongly.
  if (/["\\]/.test(name)) {
    return res.status(400).json({ error: "A library name cannot contain quotes or backslashes" });
  }
  const token = tokenOf(req);
  if (!token) return res.status(401).json({ error: "No GitHub token provided" });
  try {
    const result = await expertsForLibrary(readerFor(token, org()), org(), name);
    res.json({ subject: { kind: "library", name }, ...result });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "expertise") });
  }
});

export default router;
