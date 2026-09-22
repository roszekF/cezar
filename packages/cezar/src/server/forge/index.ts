import type { RepoInfo } from '../git.ts';
import { createGithubDriver } from './github.ts';
import type {
  ForgeChecksData,
  ForgeCommentsData,
  ForgeDriver,
  ForgeKind,
  ForgeListData,
  ForgeListOptions,
  ForgeRefStatusData,
  ForgeSearchData,
} from './types.ts';

/**
 * Forge resolution (cockpit-ui redesign spec §"Forge-driver seam"): map the
 * repo's origin remote to a driver — github.com → the GitHub driver, anything
 * else (GitLab, self-hosted, no remote, not a repo) → null. The health route
 * serializes the result as `forge: {kind, available, reason?} | null`; a null
 * forge means plain-git features only (diffs, commit, push, branches).
 */

export interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse a git remote URL into host/owner/repo. Handles the scheme forms
 * (`https://`, `ssh://`, `git://`, with optional credentials and port) and the
 * scp-like form (`git@host:owner/repo.git`). Null for local paths and anything
 * else that doesn't look like a forge remote.
 */
export function parseRemote(remote: string): ParsedRemote | null {
  const r = remote.trim().replace(/\/+$/, '');
  let host: string | undefined;
  let path: string | undefined;
  const url = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(r);
  if (url) {
    [, host, path] = url;
  } else {
    // scp-like: [user@]host:owner/repo(.git) — a leading '/' (local path)
    // can't match the host group, so plain directories fall through to null.
    const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(r);
    if (!scp) return null;
    [, host, path] = scp;
  }
  if (!host || !path) return null;
  const parts = path.replace(/\.git$/i, '').split('/').filter(Boolean);
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!owner || !repo) return null;
  return { host: host.toLowerCase(), owner, repo };
}

/** Remote host → forge kind. The one host table both `resolveForge` and the
 *  registry probe read; GitLab lands here later as one more row. */
const FORGE_HOSTS: Record<string, ForgeKind> = { 'github.com': 'github' };

/**
 * Which forge a remote URL belongs to, without building a driver (#698): the
 * registry's per-project probe classifies each root from its remote alone —
 * plain string parsing, no `gh` shell-out — so the sidebar can gate each
 * project's GitHub tab on the project's own remote.
 */
export function forgeKindOfRemote(remote: string | undefined): ForgeKind | null {
  const parsed = remote ? parseRemote(remote) : null;
  return parsed ? (FORGE_HOSTS[parsed.host] ?? null) : null;
}

/**
 * A remote's web root — `https://github.com/owner/repo` — or null for anything not on a known
 * forge host.
 *
 * Built from the PARSED remote, never by string-editing the raw one, and that is the point: a
 * remote may carry credentials (`https://user:token@github.com/o/r.git`), and this is a value the
 * cockpit renders and links to. Rebuilding it from `{host, owner, repo}` leaves nothing to leak.
 */
export function forgeWebRoot(remote: string | undefined): string | null {
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed || !(parsed.host in FORGE_HOSTS)) return null;
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}`;
}

/** Remote host → driver | null. GitLab lands here later as one more case. */
export function resolveForge(repoInfo: RepoInfo | null): ForgeDriver | null {
  if (!repoInfo?.remote) return null;
  const parsed = parseRemote(repoInfo.remote);
  if (!parsed) return null;
  if (FORGE_HOSTS[parsed.host] === 'github') {
    return createGithubDriver(repoInfo.root, { owner: parsed.owner, repo: parsed.repo });
  }
  return null;
}

/** Why a forge read answers `available: false` when the project resolves to no driver at all (no
 *  remote, a local-path remote, or a host no driver claims). Before the routes went through
 *  `resolveForge` this text came from `gh`'s own stderr, so there was no literal to keep. */
export const NO_FORGE_REASON = 'No supported forge remote detected';

/**
 * The `GET /api/github` listing through the driver seam (spec 2026-08-10-forge-provider-adapters).
 * `listAll` serves the whole payload; a driver without it is listed through `listIssues` +
 * `listPRs`, which cannot know the repo handle or label colors and so leave them out. A null forge
 * and a failing fallback both land on the tab's quiet degrade — never a throw.
 */
export async function listForgeItems(forge: ForgeDriver | null, opts: ForgeListOptions): Promise<ForgeListData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON, issues: [], prs: [] };
  if (forge.listAll) return forge.listAll(opts);
  try {
    const [issues, prs] = await Promise.all([forge.listIssues(opts), forge.listPRs(opts)]);
    return { available: true, syncedAt: new Date().toISOString(), issues, prs };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0]?.trim();
    return { available: false, reason: reason || `${forge.kind} listing failed`, issues: [], prs: [] };
  }
}

/**
 * The `GET /api/github/search` hits through the driver seam (#730, spec
 * 2026-08-10-forge-provider-adapters). A null forge, or one without `searchItems`, degrades in the
 * payload — the route never 5xxs over a missing capability.
 */
export async function searchForgeItems(
  forge: ForgeDriver | null,
  kind: 'issue' | 'pr',
  query: string,
  opts: { limit?: number },
): Promise<ForgeSearchData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON, items: [] };
  if (!forge.searchItems) return { available: false, reason: `Search is not supported for this ${forge.kind} remote`, items: [] };
  return forge.searchItems(kind, query, opts);
}

/**
 * The `GET /api/github/comments/:kind/:number` thread through the driver seam (#499, #525, spec
 * 2026-08-10-forge-provider-adapters). A null forge, or one without `listComments`, degrades in the
 * payload — the route never 5xxs over a missing capability.
 */
export async function listForgeComments(
  forge: ForgeDriver | null,
  kind: 'issue' | 'pr',
  number: number,
  opts: { refresh?: boolean },
): Promise<ForgeCommentsData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON, comments: [] };
  if (!forge.listComments) return { available: false, reason: `Comments are not supported for this ${forge.kind} remote`, comments: [] };
  return forge.listComments(kind, number, opts);
}

/**
 * The `GET /api/github/checks` lazy CI glyphs through the driver seam (#664, spec
 * 2026-08-10-forge-provider-adapters). A null forge, or one without `listChecks`, degrades in the
 * payload — the route never 5xxs over a missing capability. Unlike the other degrade payloads this
 * one has no list field to empty (`ForgeChecksData`'s unavailable branch carries only `reason`).
 */
export async function listForgeChecks(forge: ForgeDriver | null, numbers: number[]): Promise<ForgeChecksData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON };
  if (!forge.listChecks) return { available: false, reason: `CI checks are not supported for this ${forge.kind} remote` };
  return forge.listChecks(numbers);
}

/**
 * The `GET /api/github/ref-status` batched chip status through the driver seam (spec
 * 2026-08-10-forge-provider-adapters, Step 1.7). A null forge, or one without `refStatus`,
 * degrades in the payload — the route never 5xxs over a missing capability. `recheckAfterMs: null`
 * here means exactly what it means everywhere else in `ForgeRefStatusData`: nothing in this
 * answer can change, so a forge that cannot answer at all has nothing worth asking again for.
 */
export async function forgeRefStatus(forge: ForgeDriver | null, prs: number[], issues: number[]): Promise<ForgeRefStatusData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON, recheckAfterMs: null };
  if (!forge.refStatus) {
    return { available: false, reason: `Reference status is not supported for this ${forge.kind} remote`, recheckAfterMs: null };
  }
  return forge.refStatus(prs, issues);
}

export type { ForgeDriver, ForgeAvailability, ForgeItem, ForgeKind, ForgePrStatus, ForgeRefKind } from './types.ts';
