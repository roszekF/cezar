import { z } from 'zod';
import { createSwrCache, isNotFound, registerProjectCacheEvictor, runCli } from './cli.ts';
import type { ParsedRemote } from './index.ts';
import type { ForgeAvailability, ForgeDriver } from './types.ts';

/**
 * The GitLab forge driver (spec 2026-08-10-forge-provider-adapters, Phase 3) — every `glab` call
 * runs with `cwd = repoRoot` through `forge/cli.ts`, so `glab` resolves the host and project from
 * the repo's own remote and its own host config; cezar never builds a project id from the path.
 *
 * Step 3.1 is the skeleton: availability (`detect` / `detectCached`) and registration. The read
 * paths, merge-request creation and `viewUrl` land in later steps; until then the list methods
 * answer empty and the optional capabilities are absent, which the routes already degrade in the
 * payload (`… is not supported for this gitlab remote`).
 */

/** The ENOENT hint (spec § Edge Cases — glab not installed). A literal rather than
 *  `notFoundReason('glab')`: the spec pins this wording, which names the product to install. */
export const GLAB_NOT_FOUND_REASON = 'glab CLI not found — install the GitLab CLI and run `glab auth login`';

/** Same TTL as GitHub's availability probe, so both forges' nav items refresh on one rhythm. */
const CACHE_MS = 60_000;
const DETECT_CACHE_MAX = 50;

/** The two fields of `glab repo view --output json` cezar keeps — everything else is stripped. */
const glabProjectSchema = z.object({
  web_url: z.string().url(),
  path_with_namespace: z.string().min(1),
});

export interface GitlabProjectInfo {
  /** The project's own web URL — exact even on an instance served under a path prefix. */
  webUrl: string;
  pathWithNamespace: string;
}

/** Per-root project identity from the last successful probe (feeds `viewUrl`, Step 3.7). Bounded
 *  like the probe cache; a failed probe leaves the last known identity in place. */
const projectInfo = new Map<string, GitlabProjectInfo>();

function rememberProject(repoRoot: string, info: GitlabProjectInfo): void {
  projectInfo.delete(repoRoot); // re-insert so this root becomes the newest
  projectInfo.set(repoRoot, info);
  while (projectInfo.size > DETECT_CACHE_MAX) {
    const oldest = projectInfo.keys().next();
    if (oldest.done) break;
    projectInfo.delete(oldest.value);
  }
}

/** The project's `web_url` as `glab` last reported it for `repoRoot`, or null before a probe. */
export function gitlabProjectWebUrl(repoRoot: string): string | null {
  return projectInfo.get(repoRoot)?.webUrl ?? null;
}

/** The project's `path_with_namespace` as `glab` last reported it for `repoRoot`, or null. */
export function gitlabProjectPath(repoRoot: string): string | null {
  return projectInfo.get(repoRoot)?.pathWithNamespace ?? null;
}

function glab(repoRoot: string, args: string[], timeout = 15_000): Promise<string> {
  return runCli('glab', repoRoot, args, { timeoutMs: timeout, maxBuffer: 50 * 1024 * 1024 });
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'glab failed';
}

/** `glab`'s own words for a failure: the first stderr line when the error carries stderr (a
 *  non-zero exit), else the error message's first line. `execFile`'s message starts with
 *  "Command failed: glab …", which says nothing the user can act on. */
function glabFailureReason(err: unknown): string {
  const stderr = typeof err === 'object' && err !== null ? (err as { stderr?: unknown }).stderr : undefined;
  if (typeof stderr === 'string' && stderr.trim()) return firstLine(stderr);
  return firstLine(err instanceof Error ? err.message : String(err));
}

/** `glab repo view` as the availability probe — auth and project existence in one call. Never
 *  rejects: a failure is an answer to cache. */
async function probeGitlab(repoRoot: string): Promise<ForgeAvailability> {
  let stdout: string;
  try {
    stdout = await glab(repoRoot, ['repo', 'view', '--output', 'json'], 5_000);
  } catch (err) {
    return { available: false, reason: isNotFound(err) ? GLAB_NOT_FOUND_REASON : glabFailureReason(err) };
  }
  let project: z.infer<typeof glabProjectSchema>;
  try {
    project = glabProjectSchema.parse(JSON.parse(stdout));
  } catch {
    return { available: false, reason: 'glab repo view returned an unexpected response' };
  }
  rememberProject(repoRoot, { webUrl: project.web_url, pathWithNamespace: project.path_with_namespace });
  return { available: true };
}

/** Cached availability probe, one entry per project — GitHub's `detectCache` semantics. */
const detectCache = createSwrCache<string, ForgeAvailability>({
  ttlMs: CACHE_MS,
  max: DETECT_CACHE_MAX,
  load: probeGitlab,
});

function detectGitlab(repoRoot: string): Promise<ForgeAvailability> {
  if (process.env.CEZ_DRY_RUN === '1') return Promise.resolve({ available: true });
  return detectCache.get(repoRoot);
}

/**
 * Non-blocking availability for `GET /api/health`: the last-known probe (even stale, while it
 * revalidates off the request path — the #508 anti-flicker guarantee), or null only when cold.
 * Never shells out on the read.
 */
export function detectGitlabCached(repoRoot: string): ForgeAvailability | null {
  if (process.env.CEZ_DRY_RUN === '1') return { available: true };
  return detectCache.peek(repoRoot);
}

// Everything GitLab caches per root, for `evictForgeProjectCaches` (project removed/re-pointed).
registerProjectCacheEvictor((repoRoot) => {
  detectCache.delete(repoRoot);
  projectInfo.delete(repoRoot);
});

/** `parsed` feeds `viewUrl`'s origin + path fallback once Step 3.7 lands; unused until then. */
export function createGitlabDriver(repoRoot: string, parsed: ParsedRemote): ForgeDriver {
  return {
    kind: 'gitlab',

    detect: () => detectGitlab(repoRoot),
    detectCached: () => detectGitlabCached(repoRoot),

    // Step 3.2 implements the listings; empty until then.
    listIssues: async () => [],
    listPRs: async () => [],

    // Step 4.1 implements draft merge requests.
    createPR: async () => ({ ok: false, error: 'Merge request creation is not implemented yet for GitLab' }),

    // Step 3.4 implements the per-branch merge-request probe.
    prStatus: async () => null,

    // Step 3.7 builds links from the cached `web_url` (falling back to origin + path).
    viewUrl: () => null,
  };
}
