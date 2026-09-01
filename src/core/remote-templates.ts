/**
 * Discover and clone open-source Summer Engine project templates hosted at
 * github.com/SummerEngine/template-*.
 *
 * The GitHub API call is cached for one hour in memory to avoid rate-limit
 * pain when an agent calls back-to-back.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const ORG = "SummerEngine";
const TEMPLATE_PREFIX = "template-";
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface RemoteTemplate {
  /** Slug used by `summer create <slug>`. The `template-` prefix is stripped. */
  slug: string;
  /** Full GitHub repo name including the `template-` prefix. */
  repo: string;
  description: string;
  /** Default branch — used when cloning. */
  branch: string;
  url: string;
  cloneUrl: string;
  stars: number;
  updatedAt: string;
}

interface CacheEntry {
  templates: RemoteTemplate[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

interface GithubRepo {
  name: string;
  description: string | null;
  default_branch: string;
  html_url: string;
  clone_url: string;
  stargazers_count: number;
  updated_at: string;
  archived: boolean;
  fork: boolean;
}

export async function fetchRemoteTemplates(opts: { force?: boolean } = {}): Promise<RemoteTemplate[]> {
  if (!opts.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.templates;
  }

  const url = `https://api.github.com/orgs/${ORG}/repos?per_page=100&type=public`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "summer-engine-cli",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${res.status}: ${res.statusText}. ${res.status === 403 ? "Rate-limited; set GITHUB_TOKEN to raise the cap." : ""}`
    );
  }

  const repos = (await res.json()) as GithubRepo[];
  const templates: RemoteTemplate[] = repos
    .filter((r) => r.name.startsWith(TEMPLATE_PREFIX) && !r.archived && !r.fork)
    .map((r) => ({
      slug: r.name.slice(TEMPLATE_PREFIX.length),
      repo: r.name,
      description: r.description ?? "",
      branch: r.default_branch,
      url: r.html_url,
      cloneUrl: r.clone_url,
      stars: r.stargazers_count,
      updatedAt: r.updated_at,
    }))
    .sort((a, b) => b.stars - a.stars || a.slug.localeCompare(b.slug));

  cache = { templates, fetchedAt: Date.now() };
  return templates;
}

export interface CloneOptions {
  /** Where to put the project. Must not already exist. */
  targetDir: string;
  /** If true, drop the .git directory after clone so the user starts with a clean history. */
  detach?: boolean;
}

export function cloneTemplate(template: RemoteTemplate, opts: CloneOptions): void {
  if (existsSync(opts.targetDir)) {
    throw new Error(`Directory already exists: ${opts.targetDir}`);
  }

  // Shallow clone for speed.
  try {
    execSync(`git clone --depth 1 --branch ${template.branch} ${template.cloneUrl} "${opts.targetDir}"`, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      `git clone failed for ${template.repo}. Is git installed? ${(err as Error).message}`
    );
  }

  if (opts.detach !== false) {
    // Default to detached: the user wants their own history.
    const gitDir = `${opts.targetDir}/.git`;
    if (existsSync(gitDir)) {
      try {
        execSync(process.platform === "win32" ? `rmdir /s /q "${gitDir}"` : `rm -rf "${gitDir}"`, {
          stdio: "ignore",
        });
      } catch {
        // best effort — user can clean up manually if it fails
      }
    }
  }
}

/** Quick match: exact slug, then prefix, then substring. Returns null if ambiguous or none. */
export function matchTemplate(query: string, templates: RemoteTemplate[]): RemoteTemplate | null {
  const exact = templates.find((t) => t.slug === query || t.repo === query);
  if (exact) return exact;

  const prefix = templates.filter((t) => t.slug.startsWith(query));
  if (prefix.length === 1) return prefix[0];

  const substring = templates.filter((t) => t.slug.includes(query));
  if (substring.length === 1) return substring[0];

  return null;
}
