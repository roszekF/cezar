/**
 * The bookmarklet generator (spec 011): the `javascript:` URL a user drags to the bookmarks
 * bar. Clicked on a GitHub PR/issue (or, since spec 2026-08-10-forge-provider-adapters Step 4.5,
 * a GitLab merge request/issue) it opens the cockpit's `/new?skill=&auto=&key=&ref=` deep link —
 * the cockpit that GENERATED the bookmarklet, whose origin is baked in at generation.
 *
 * Why no localhost port-scan probe anymore: the legacy program fetched
 * `http://localhost:4321-4330/api/health` from github.com to discover a running cockpit and pick
 * the one serving the page's repo. GitHub's Content-Security-Policy (`default-src 'none'` + a
 * fixed `connect-src` allowlist) BLOCKS any fetch/XHR to localhost from the page context a
 * bookmarklet runs in, so every probe throws "Failed to fetch" and the launcher wrongly reported
 * "cockpit is not running" even with a cockpit up (verified against GitHub's live CSP, 2026-07).
 * A top-level navigation (`window.open`) is NOT subject to `connect-src`, so we open the cockpit
 * directly. Baking the generating origin also makes it exact: the bookmarklet opens the very
 * cockpit you saved it from — no guessing the port, and multi-repo users get the right one for
 * free (each cockpit stamps its own origin).
 *
 * CSP caveat for GitLab: the "no fetch, only navigate" reasoning above was VERIFIED against
 * GitHub's live CSP (2026-07). It is UNVERIFIED for GitLab — this run has no live GitLab
 * instance to test the bookmarklet against (gitlab.com or self-managed), so the GitLab matcher
 * ships on the assumption that `window.open` is equally unrestricted there. The GitHub form
 * itself is unchanged by this Step.
 *
 * The `/new?skill=&auto=&key=&ref=` deep-link grammar is a PROTECTED contract
 * (BACKWARD_COMPATIBILITY.md §1) and is unchanged — only the client-side discovery is.
 *
 * Multi-project (spec, step 3.6): a generated launcher now names the project it was generated
 * from — `<origin>/p/<projectId>/new?…` — carrying that project's own launch key (each repo
 * keeps its own `.ai/cezar/launch-key`; the scoped API client already fetches the right one).
 * Only the PATH gained a prefix: the query grammar after `?` is byte-identical, and already
 * saved flat `/new?…` bookmarklets keep landing because the cockpit permanently redirects
 * legacy paths onto the boot project's scoped twin (routes.tsx `LegacyPathRedirect`). Passing
 * no project id yields exactly the legacy path, so an unscoped caller is unchanged.
 *
 * `alert()` in the generated code is deliberate: the program runs on github.com (or a GitLab
 * host), where the cockpit's toaster does not exist (the design guardian carries the matching
 * file allowance).
 *
 * GitLab matcher (spec 2026-08-10-forge-provider-adapters, Step 4.5): the page matcher is built
 * from a list of GitLab hosts the caller passes in (`gitlabHosts` below) — `gitlab.com` plus any
 * self-managed host the workspace has a registered `forge: 'gitlab'` project on
 * (`routes/settings/bookmarklets-section.tsx` derives this list from `useProjects()`'s
 * `forge`/`repoUrl` pair, the same registry `BookmarkletPanel` already reads for labels and
 * scoping). An EMPTY list (the default — no caller-known GitLab host) reproduces the pre-GitLab
 * matcher and alert text byte for byte, so every already-saved bookmarklet, and every call site
 * that does not pass hosts, is unaffected. The GitLab URL shape mirrors the server-side one
 * (`runs/store.ts` `GITLAB_PROJECT_URL`, Step 4.4): `https://<host>/<path…>/-/(merge_requests|
 * issues)/N`, path at least two segments so subgroups match. Host dots are escaped so
 * `gitlab.example.com` cannot match `gitlabXexampleXcom`.
 */

/** The cockpit's default origin — the fallback when a caller can't supply `window.location.origin`. */
export const DEFAULT_COCKPIT_ORIGIN = 'http://localhost:4321'

/** The pre-GitLab, GitHub-only page matcher — kept as a named constant so the empty-hosts branch
 *  of `buildMatcher` below is provably the exact string this file always generated. */
const GITHUB_PATTERN = String.raw`^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/(pull|issues)\/\d+`
const GITHUB_ALERT = 'Open a GitHub PR or issue first'
const BOTH_FORGES_ALERT = 'Open a GitHub or GitLab pull/merge request or issue first'

/** Escapes a host's dots for splicing into the regex source below — a host must match itself
 *  literally, not any single character in its place (`gitlab.com` must not match `gitlabXcom`). */
function escapeHostDots(host: string): string {
  return host.replace(/\./g, '\\.')
}

/**
 * Builds the page matcher (a regex source string, no delimiters) and its alert copy from a list
 * of known GitLab hosts (spec 2026-08-10-forge-provider-adapters, Step 4.5). An empty list
 * reproduces today's GitHub-only matcher and alert text byte for byte.
 */
function buildMatcher(gitlabHosts: readonly string[]): { pattern: string; alert: string } {
  if (gitlabHosts.length === 0) return { pattern: GITHUB_PATTERN, alert: GITHUB_ALERT }
  const hostAlternation = gitlabHosts.map(escapeHostDots).join('|')
  // Same shape as `runs/store.ts`'s server-side `GITLAB_PROJECT_URL` (Step 4.4): everything
  // before `/-/` is the project path, at least two segments so a subgroup (`group/sub/repo`)
  // matches too. Unlike the server-side pattern the host is a fixed whitelist here (this code
  // runs on an arbitrary page, not against a known project's remote), so no host exclusion is
  // needed.
  const gitlabPattern = String.raw`^https:\/\/(?:${hostAlternation})\/(?:[^\/]+\/){1,}[^\/]+\/-\/(?:merge_requests|issues)\/\d+`
  return { pattern: `${GITHUB_PATTERN}|${gitlabPattern}`, alert: BOTH_FORGES_ALERT }
}

export function bookmarkletUrl(
  skillName: string,
  auto: boolean,
  key: string,
  origin: string = DEFAULT_COCKPIT_ORIGIN,
  projectId: string | null = null,
  gitlabHosts: readonly string[] = [],
): string {
  // `'` survives encodeURIComponent — it would break the single-quoted JS strings below.
  const enc = (s: string) => encodeURIComponent(s).replaceAll("'", '%27')
  const query = `${skillName ? `skill=${enc(skillName)}&` : ''}auto=${auto ? '1' : '0'}&key=${enc(key)}&ref=`
  // Keep the origin's `://` intact (do NOT URI-encode it — it goes straight into `open()`); only
  // neutralize a stray apostrophe so it can't break the embedded string.
  const base = origin.replaceAll("'", '%27')
  // The composer's path for the named project. Null (no scope) keeps the legacy flat `/new`,
  // which the cockpit redirects to the boot project anyway — so both spellings still land.
  const path = projectId === null || projectId === '' ? '/new' : `/p/${enc(projectId)}/new`
  const { pattern, alert } = buildMatcher(gitlabHosts)
  const code =
    `(()=>{const m=location.href.match(/${pattern}/);` +
    `if(!m){alert('${alert}');return;}` +
    `const q='${query}'+encodeURIComponent(location.href);` +
    `open('${base}${path}?'+q,'_blank');})();`
  return `javascript:${encodeURIComponent(code)}`
}

/**
 * Derives the GitLab hosts a caller should pass to `bookmarkletUrl` from the project registry
 * (`GET /api/v1/projects`): `gitlab.com` always (the well-known default, mirroring the server's
 * `forge/discovery.ts` well-known host map), plus every registered project's `repoUrl` origin
 * where `forge === 'gitlab'` — a self-managed instance the workspace already knows about.
 */
export function gitlabHostsFromProjects(
  projects: readonly { forge?: string; repoUrl?: string }[] | undefined,
): string[] {
  const hosts = new Set<string>(['gitlab.com'])
  for (const project of projects ?? []) {
    if (project.forge !== 'gitlab' || !project.repoUrl) continue
    try {
      hosts.add(new URL(project.repoUrl).host)
    } catch {
      // Malformed repoUrl (should not happen — server-built) — skip it, the known hosts stand.
    }
  }
  return Array.from(hosts)
}
