import { z } from 'zod';
import { createSwrCache, isNotFound, registerProjectCacheEvictor, runCli } from './cli.ts';
import type { ParsedRemote } from './index.ts';
import type { ForgeAvailability, ForgeDriver, ForgeItem, ForgeListData, ForgeListOptions } from './types.ts';

/**
 * The GitLab forge driver (spec 2026-08-10-forge-provider-adapters, Phase 3) — every `glab` call
 * runs with `cwd = repoRoot` through `forge/cli.ts`, so `glab` resolves the host and project from
 * the repo's own remote and its own host config; cezar never builds a project id from the path.
 *
 * Step 3.1 built the skeleton: availability (`detect` / `detectCached`) and registration. Step 3.2
 * adds the list tier (`listIssues`/`listPRs`/`listAll`) — both open-only, mirroring `fetchGithub`'s
 * `GET /github` tier. The remaining optional capabilities (`listComments`, `listChecks`, …) stay
 * absent until their own Steps, which the routes already degrade in the payload (`… is not
 * supported for this gitlab remote`).
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

// ---- listIssues / listPRs / listAll (Step 3.2) -----------------------------------------------
// `glab issue list` / `glab mr list` — both OPEN-only by default, matching GitHub's list tier
// (`gh issue/pr list` also defaults to `--state open`). Always the LONG `--output json` spelling:
// `glab`'s short `-F`/`-O` flags mean different things between `issue list` and `mr list` (Drift
// note, spec 2026-08-10-forge-provider-adapters), so the long form is the only one that reads the
// same on both commands.

/** Item body cap — identical to GitHub's (`github.ts` slices `body` the same way). */
const ITEM_BODY_CAP = 8_000;

/** GitLab's own `--per-page` ceiling: the API clamps any larger request server-side, and `glab
 *  issue/mr list` makes exactly one call (no `--all` walk here — Step 3.2 is the open-only list
 *  tier, not the bounded multi-page reader Steps 3.3/3.5 need). A `limit` beyond this is the
 *  documented cap, mirroring GitHub's `GH_MAX_LIMIT` clamp but for GitLab's own ceiling. */
export const GL_MAX_LIMIT = 100;

// `gl…` = GitLab REST fields, straight off `glab issue/mr list --output json` (the same shape as
// the GitLab REST API — glab's JSON output IS the REST response). Extras are stripped by zod.
const glAuthorSchema = z.object({ username: z.string() }).nullish();
const glIssueRowSchema = z.object({
  iid: z.number(),
  title: z.string(),
  author: glAuthorSchema,
  created_at: z.string(),
  labels: z.array(z.string()).default([]),
  description: z.string().nullish(),
  web_url: z.string(),
  user_notes_count: z.number().default(0),
});
// MRs carry both the current `draft` field and the legacy `work_in_progress` one — some GitLab
// versions/API paths still only set the latter (D5, spec Step 3.2).
const glMrRowSchema = glIssueRowSchema.extend({
  draft: z.boolean().default(false),
  work_in_progress: z.boolean().default(false),
});
type GlIssueRow = z.infer<typeof glIssueRowSchema>;
type GlMrRow = z.infer<typeof glMrRowSchema>;

function toForgeItem(kind: 'issue', row: GlIssueRow): ForgeItem;
function toForgeItem(kind: 'pr', row: GlMrRow): ForgeItem;
function toForgeItem(kind: 'issue' | 'pr', row: GlIssueRow | GlMrRow): ForgeItem {
  const base: ForgeItem = {
    kind,
    number: row.iid, // NOT `id` — `iid` is the project-scoped number the cockpit and links use.
    title: row.title,
    author: row.author?.username ?? '?',
    createdAt: row.created_at,
    labels: row.labels,
    body: (row.description ?? '').slice(0, ITEM_BODY_CAP),
    url: row.web_url,
    comments: row.user_notes_count,
  };
  if (kind === 'pr') {
    const mr = row as GlMrRow;
    // `checks: null` per D5 — hydrated lazily via `listChecks` once Step 3.4 lands, exactly like
    // GitHub's list tier has done since #664.
    return { ...base, isDraft: mr.draft || mr.work_in_progress, checks: null };
  }
  return base;
}

const glLabelRowSchema = z.object({ name: z.string(), color: z.string() });

/** Best-effort repo-wide `label name → 6-hex color` map (no `#`, matching the form GitHub's
 *  `labelColors` uses). `:fullpath` is glab's own placeholder — resolved from the repo's remote,
 *  never a path cezar builds (Minor 5, spec 2026-08-10-forge-provider-adapters). Returns `null` on
 *  any failure so the caller can leave `labelColors` off the payload rather than fail the list. */
async function fetchGitlabLabelColors(repoRoot: string): Promise<Record<string, string> | null> {
  try {
    const out = await glab(repoRoot, ['api', 'projects/:fullpath/labels?per_page=100'], 10_000);
    const rows = z.array(glLabelRowSchema).parse(JSON.parse(out));
    const colors: Record<string, string> = {};
    for (const row of rows) {
      const hex = row.color.replace(/^#/, '').toLowerCase();
      if (hex && !colors[row.name]) colors[row.name] = hex;
    }
    return colors;
  } catch {
    return null;
  }
}

/** Same TTL/bound as the detect cache, keyed by `repoRoot` — one cached listing per project, a
 *  cached fetch with a bigger `limit` than asked serves fine (superset), mirroring `fetchGithub`'s
 *  `listCache`. */
const listCache = new Map<string, { at: number; limit: number; data: ForgeListData }>();
const LIST_CACHE_MAX = 50;

registerProjectCacheEvictor((repoRoot) => listCache.delete(repoRoot));

/** CEZ_DRY_RUN=1 — a small fixed catalog on a demo gitlab.com project, mirroring GitHub's
 *  `mockGithub` so the tab is demoable offline for either forge. */
function mockGitlabList(): ForgeListData {
  const now = Date.now();
  return {
    available: true,
    repo: 'demo/demo',
    syncedAt: new Date(now).toISOString(),
    issues: [
      {
        kind: 'issue',
        number: 1,
        title: 'Pipeline fails on forked merge requests',
        author: 'demo',
        createdAt: new Date(now - 3_600_000).toISOString(),
        labels: ['bug'],
        body: 'CI jobs that need protected variables are skipped on a forked MR, so the pipeline reports failed rather than skipped.',
        url: 'https://gitlab.com/demo/demo/-/issues/1',
        comments: 2,
      },
    ],
    prs: [
      {
        kind: 'pr',
        number: 1,
        title: 'Draft: wire up the release pipeline',
        author: 'demo',
        createdAt: new Date(now - 7_200_000).toISOString(),
        labels: ['ci'],
        body: 'Adds the `.gitlab-ci.yml` release stage. Still needs the tag-protection rule before review.',
        url: 'https://gitlab.com/demo/demo/-/merge_requests/1',
        comments: 1,
        isDraft: true,
        checks: null,
      },
    ],
    labelColors: { bug: 'd73a4a', ci: '6699cc' },
  };
}

/** The `GET /api/github` listing for a GitLab remote — both open sets, repo handle and best-effort
 *  label colors, cached and refreshable exactly like `fetchGithub`. Never throws: a CLI failure,
 *  missing binary or malformed payload all land on `{available: false, reason}`. */
async function fetchGitlabList(repoRoot: string, parsed: ParsedRemote, opts?: ForgeListOptions): Promise<ForgeListData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGitlabList();
  const capped = Math.min(Math.max(opts?.limit ?? 30, 1), GL_MAX_LIMIT);
  const refresh = !!opts?.refresh;
  const hit = listCache.get(repoRoot);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS && hit.limit >= capped) return hit.data;
  try {
    const [issuesOut, prsOut] = await Promise.all([
      glab(repoRoot, ['issue', 'list', '--output', 'json', '--per-page', String(capped)], 15_000),
      glab(repoRoot, ['mr', 'list', '--output', 'json', '--per-page', String(capped)], 15_000),
    ]);
    let issueRows: GlIssueRow[];
    try {
      issueRows = z.array(glIssueRowSchema).parse(JSON.parse(issuesOut));
    } catch {
      return { available: false, reason: 'glab issue list returned an unexpected response', issues: [], prs: [] };
    }
    let mrRows: GlMrRow[];
    try {
      mrRows = z.array(glMrRowSchema).parse(JSON.parse(prsOut));
    } catch {
      return { available: false, reason: 'glab mr list returned an unexpected response', issues: [], prs: [] };
    }
    const labelColors = await fetchGitlabLabelColors(repoRoot);
    const data: ForgeListData = {
      available: true,
      repo: parsed.path,
      syncedAt: new Date().toISOString(),
      issues: issueRows.map((row) => toForgeItem('issue', row)),
      prs: mrRows.map((row) => toForgeItem('pr', row)),
      ...(labelColors ? { labelColors } : {}),
    };
    listCache.delete(repoRoot); // re-insert so this key becomes the newest
    listCache.set(repoRoot, { at: Date.now(), limit: capped, data });
    while (listCache.size > LIST_CACHE_MAX) {
      const oldest = listCache.keys().next();
      if (oldest.done) break;
      listCache.delete(oldest.value);
    }
    return data;
  } catch (err) {
    const reason = isNotFound(err) ? GLAB_NOT_FOUND_REASON : glabFailureReason(err);
    return { available: false, reason, issues: [], prs: [] };
  }
}

/** `parsed` feeds `listAll`'s `repo` field and `viewUrl`'s origin + path fallback (Step 3.7). */
export function createGitlabDriver(repoRoot: string, parsed: ParsedRemote): ForgeDriver {
  return {
    kind: 'gitlab',

    detect: () => detectGitlab(repoRoot),
    detectCached: () => detectGitlabCached(repoRoot),

    listIssues: async (opts) => (await fetchGitlabList(repoRoot, parsed, opts)).issues,
    listPRs: async (opts) => (await fetchGitlabList(repoRoot, parsed, opts)).prs,

    // The tab's whole payload in one call — repo handle, both open sets, label colors.
    listAll: (opts) => fetchGitlabList(repoRoot, parsed, opts),

    // Step 4.1 implements draft merge requests.
    createPR: async () => ({ ok: false, error: 'Merge request creation is not implemented yet for GitLab' }),

    // Step 3.4 implements the per-branch merge-request probe.
    prStatus: async () => null,

    // Step 3.7 builds links from the cached `web_url` (falling back to origin + path).
    viewUrl: () => null,
  };
}
