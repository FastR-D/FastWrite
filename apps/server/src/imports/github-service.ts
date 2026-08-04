import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { GithubImportRequest, PaperProject } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { WorkspaceService } from "../workspace/workspace-service";

interface GithubLocation {
  owner: string;
  repository: string;
  cloneUrl: string;
}

export class GithubService {
  constructor(private readonly dataDirectory: string, private readonly workspaces: WorkspaceService) {}

  async import(request: GithubImportRequest): Promise<PaperProject> {
    const location = parseGithubRepository(request.repository);
    const requestedRef = request.ref?.trim() || "HEAD";
    if (requestedRef !== "HEAD" && (!/^[\w./-]{1,200}$/.test(requestedRef) || requestedRef.startsWith("-") || requestedRef.includes("..") || requestedRef.includes("@{"))) {
      throw new ApiError(400, "invalid_github_ref", "Branch, tag, or commit is invalid");
    }
    const importsRoot = join(this.dataDirectory, "imports");
    await mkdir(importsRoot, { recursive: true });
    const temporary = await mkdtemp(join(importsRoot, "github-"));
    const cloneDirectory = join(temporary, "repository");

    try {
      const gitEnvironment = githubGitEnvironment();
      const clone = Bun.spawn(["git", "clone", "--depth", "1", "--no-tags", "--", location.cloneUrl, cloneDirectory], { stdout: "pipe", stderr: "pipe", env: gitEnvironment });
      const cloneError = await new Response(clone.stderr).text();
      if ((await clone.exited) !== 0) throw new ApiError(400, "github_clone_failed", cleanGitError(cloneError));

      if (requestedRef !== "HEAD") {
        const fetch = Bun.spawn(["git", "-C", cloneDirectory, "fetch", "--depth", "1", "origin", requestedRef], { stdout: "pipe", stderr: "pipe", env: gitEnvironment });
        const fetchError = await new Response(fetch.stderr).text();
        if ((await fetch.exited) !== 0) throw new ApiError(400, "github_ref_not_found", cleanGitError(fetchError));
        const checkout = Bun.spawn(["git", "-C", cloneDirectory, "checkout", "--detach", "FETCH_HEAD"], { stdout: "pipe", stderr: "pipe", env: gitEnvironment });
        const checkoutError = await new Response(checkout.stderr).text();
        if ((await checkout.exited) !== 0) throw new ApiError(400, "github_checkout_failed", cleanGitError(checkoutError));
      }

      const revision = Bun.spawn(["git", "-C", cloneDirectory, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
      const commit = (await new Response(revision.stdout).text()).trim();
      if ((await revision.exited) !== 0 || !/^[0-9a-f]{40}$/i.test(commit)) {
        throw new ApiError(500, "github_revision_failed", "The imported Git revision could not be resolved");
      }

      const importedRef = requestedRef === "HEAD" ? await currentBranch(cloneDirectory) : requestedRef;
      const project = await this.workspaces.copyExternalDirectory({
        sourceDirectory: cloneDirectory,
        name: request.name?.trim() || location.repository,
        ...(request.mainDocument ? { mainDocument: request.mainDocument } : {}),
        venue: request.venue ?? "security-top4",
        source: {
          type: "github",
          repository: `https://github.com/${location.owner}/${location.repository}`,
          ref: importedRef,
          commit
        }
      });
      return project;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export function parseGithubRepository(value: string): GithubLocation {
  let normalized = value.trim();
  if (/^git@github\.com:/i.test(normalized)) normalized = normalized.replace(/^git@github\.com:/i, "https://github.com/");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new ApiError(400, "invalid_github_url", "Enter a GitHub repository URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new ApiError(400, "invalid_github_url", "Only https://github.com repositories are supported");
  }
  const segments = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new ApiError(400, "invalid_github_url", "The URL must point to a GitHub owner/repository");
  }
  const [owner, repository] = segments;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repository)) {
    throw new ApiError(400, "invalid_github_url", "The GitHub owner or repository name is invalid");
  }
  return { owner, repository, cloneUrl: `https://github.com/${owner}/${repository}.git` };
}

export function githubGitEnvironment(): Record<string, string | undefined> {
  const token = process.env.FASTWRITE_GITHUB_TOKEN?.trim();
  return token ? {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    GIT_TERMINAL_PROMPT: "0"
  } : { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

export function cleanGitError(message: string): string {
  const cleaned = message
    .replace(/Cloning into '[^']+'\.\.\.\s*/gi, "")
    .replace(/https:\/\/[^@\s]+@github\.com/gi, "https://github.com")
    .replace(/Authorization:\s*(?:Basic|Bearer)\s+\S+/gi, "Authorization: [redacted]")
    .trim();
  if (/repository not found/i.test(cleaned)) return "GitHub repository not found or access was denied";
  if (/authentication failed|could not read username/i.test(cleaned)) return "GitHub authentication failed. Check FASTWRITE_GITHUB_TOKEN.";
  return cleaned.slice(-800) || "GitHub repository could not be cloned";
}

async function currentBranch(directory: string): Promise<string> {
  const branch = Bun.spawn(["git", "-C", directory, "symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const name = (await new Response(branch.stdout).text()).trim();
  return (await branch.exited) === 0 && name ? name : "HEAD";
}
