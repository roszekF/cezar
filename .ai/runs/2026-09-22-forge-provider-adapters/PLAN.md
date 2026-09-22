# Execution plan — forge provider adapters (GitHub + GitLab)

**Date:** 2026-09-22
**Slug:** forge-provider-adapters
**Branch:** `feat/forge-provider-adapters` (fork `roszekF/cezar`; nothing is pushed to `open-mercato/cezar`)
**Source spec:** `.ai/specs/2026-08-10-forge-provider-adapters.md` — carried on branch `spec/forge-provider-adapters` (upstream spec PR `open-mercato/cezar#848`, unmerged); materialized untracked in the worktree, never committed on this branch
**Base:** `main` @ `4763447f` (v0.11.1)
**Engine:** om-auto-create-pr-loop (steps: 28, --loop: no)

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and set `Commit` to `pending`; the next checkpoint commit backfills the real short SHAs (a commit cannot contain its own SHA). The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids and `Exec` cells are immutable once the plan is committed — per-Step commits touch only `Status` and `Commit`.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 1 | 1.1 | Widen ForgeKind and add optional driver capabilities | dispatch | done | 5c03e161 |
| 1 | 1.2 | Widen the contract schemas and their narrowing consumers | dispatch | done | d72ef57d |
| 1 | 1.3 | Extract forge/cli.ts shared adapter plumbing | dispatch:capable | done | a45d4b4e |
| 1 | 1.4 | Route GET /github and /github/search through the driver | dispatch:capable | done | d078b602 |
| 1 | 1.5 | Route GET /github/comments through forge.listComments | dispatch | done | a05ebeda |
| 1 | 1.6 | Route GET /github/checks through forge.listChecks | dispatch | done | 336d55bb |
| 1 | 1.7 | Route GET /github/ref-status through forge.refStatus | dispatch | done | ea6aada9 |
| 1 | 1.8 | Route PR changes and draft-PR creation through the driver | dispatch | done | 81a4912b |
| 2 | 2.1 | Add forge/discovery.ts with the host ladder and cache | dispatch | done | pending |
| 2 | 2.2 | Wire discovery into forge/index.ts and the boot warm-up | dispatch:capable | done | pending |
| 2 | 2.3 | Carry path and web origin on ParsedRemote | dispatch | todo | — |
| 2 | 2.4 | Build the GitHub viewUrl from the parsed origin | dispatch:cheap | todo | — |
| 3 | 3.1 | GitLab driver skeleton with detect and registration | dispatch:capable | todo | — |
| 3 | 3.2 | GitLab listIssues and listPRs | dispatch | todo | — |
| 3 | 3.3 | GitLab listComments with timeline events | dispatch | todo | — |
| 3 | 3.4 | GitLab listChecks and prStatus | dispatch | todo | — |
| 3 | 3.5 | GitLab prDiff with forge-neutral caps | dispatch | todo | — |
| 3 | 3.6 | GitLab searchItems | dispatch:cheap | todo | — |
| 3 | 3.7 | GitLab viewUrl | dispatch:cheap | todo | — |
| 3 | 3.8 | Cockpit forge label, icon and copy from health.forge.kind | dispatch | todo | — |
| 3 | 3.9 | Forge-neutral task reference chips in the cockpit | dispatch | todo | — |
| 4 | 4.1 | GitLab draft merge request creation | dispatch:capable | todo | — |
| 4 | 4.2 | Clone from a GitLab remote | dispatch:capable | todo | — |
| 4 | 4.3 | Host tooling, agent env and redaction for glab | dispatch | todo | — |
| 4 | 4.4 | Run bookkeeping learns GitLab URL shapes | dispatch | todo | — |
| 4 | 4.5 | Bookmarklet matcher from discovered hosts | dispatch:cheap | todo | — |
| 4 | 4.6 | GitHub-event automations require a GitHub forge | dispatch | todo | — |
| 4 | 4.7 | Documentation for the second forge | inline | todo | — |
| 1 | 1.7-review-fix | Type the driver-stub test payloads explicitly | inline | done | 5f7bae12 |
| 1 | 1.8-review-fix | Keep the pre-seam draft-PR path when no forge resolves | inline | done | 7ec3ab5f |

## Goal

Finish the `ForgeDriver` seam and add a `glab`-backed GitLab adapter so a project on gitlab.com or a self-managed GitLab gets the forge tab, draft merge requests from the review gate, linking task chips, clone-from-forge and CI glyphs — discovered, never configured — while a GitHub project behaves byte-identically to today.

## Scope

- `packages/cezar/src/server/forge/` (types, cli, discovery, index, github, gitlab), the `/github*` route family and `POST /runs/:id/pr` in `server.ts`, `packages/contract/src/{health,projects}.ts`.
- Workspace integration: `server/checkout.ts`, `core/{backend-detect,agent-env,secret-redaction}.ts`, `server-install/steps.ts`, `runs/{store,task-refs}.ts`, automations availability.
- Cockpit: nav label/icon, unavailable-state copy, `lib/{git-actions,tasks-table,bookmarklet}.ts`, clone dialog copy.

## Non-goals

- GitLab reference-status chips (`/github/ref-status`), merge-state and merge: the optional driver methods stay absent for GitLab and the routes answer their existing in-payload degradation — chips render neutral, the merge panel reads unavailable.
- Generalizing Automations to GitLab (event poller, `github.*` tokens), a neutral `/api/v1/forge*` family, renaming `/github` routes or the cockpit URL, a token/REST transport, Bitbucket/Gitea/Forgejo/Azure adapters (spec § Deliberately not addressed).
- `runs/arm-repo-handle.ts` (`gh`-only repo handle memo): on a GitLab repo it already fails quietly and memoizes the negative; untouched.
- `readHostGithubToken` → `readHostForgeToken(kind)` (spec Step 22): the function has no callers on `main`, so renaming dead code is dropped.

## Review of the spec (upstream #848, sheeerth, CHANGES_REQUESTED 2026-08-14) — how each finding lands

| Finding | Resolution in this plan |
|---|---|
| Major 1 — the cockpit's duplicated remote parser (`tasks-table.ts` `githubRepoBase`/`synthesizeUrl`) is in no phase; GitLab chips ship inert or 404 | New Step 3.9: `forgeRepoBase(remote, kind)` with the same subgroup fix as 2.3, `synthesizeUrl` emits `/-/merge_requests/N` and `/-/issues/N` for `gitlab`, the "change both parsers in one commit" rule documented in both files. |
| Major 2 — `ParsedRemote` gains only `path`, but `viewUrl` needs scheme and port | Step 2.3 adds `path` **and** `origin` (web origin). Rule: `http(s)://` remotes keep scheme and port; `ssh://`, `git://` and scp-form remotes map to `https://<host>` with no port (an SSH port is never a web port). `forgeWebRoot` builds from `origin` + `path`. Table tests assert the built URL for `http://`, port-bearing and scp on-prem remotes. |
| Major 3 — Automations gate contradicts itself; gating `/api/v1/automations*` would break a §2-protected family | Resolved as **availability-only**, and re-based on main's automations redesign (2026-09-14): the nav item already no longer requires a GitHub remote, and schedule automations work anywhere. Step 4.6 makes *GitHub-event* automations available only when `forge.kind === 'github'` (the `available` flag of `GET /automations`, the manual check, boot poller registration — which today compare the literal host `github.com`). No route, status code or nav gate changes; a GitLab project reads like a repo without a GitHub remote today. |
| Minor 4 — `forgeWebRoot` is a third `FORGE_HOSTS` reader; rebase + re-inventory | Rebased (spec branch now on `4763447f`), inventory re-run 2026-09-22 (Drift below). Step 2.2 routes `forgeWebRoot` through discovery; `repoUrl` on `GET /api/v1/projects` widens to GitLab web roots in the same step. |
| Minor 5 — one `path` cannot serve both `viewUrl` and `glab api` `:id` on a non-root instance | `glab api` is always called with `cwd = repoRoot` and the `:fullpath` placeholder, so `glab` resolves the project from its own host config — cezar never builds `:id` from `path`. `viewUrl` prefers the project `web_url` that `detect()` caches from `glab repo view --output json` (exact for non-root instances), falling back to `origin` + `path`. |
| Extra test — read-only cache directory | Step 2.1 tests a read-only `~/.cache/cez` (AGENTS.md § Zero config: a read-only home degrades, never fails boot). |

## Drift since the spec (`bbd77e9b` → `4763447f`)

- **Five** `/github*` routes bypass the driver, not four: `/github/search` (#730) and `/github/ref-status` are new. 1.4 and 1.7 cover them; `ForgeDriver.searchItems?` already exists.
- `server.ts` reaches the GitHub module through re-export shims `server/github.ts` and `server/pr.ts`.
- `detectCache` is already a keyed LRU with in-flight join (`github.ts:2580`), so 1.3 extracts it rather than rewrites it; the stale-while-revalidate guarantee (#508) is pinned by a test that must stay green.
- Latent bug found: `evictGithubProjectCaches` clears comments with a `${root}:` prefix, but comment keys are `${root}\0${kind}#${n}` — comments are never evicted. 1.3 fixes it in `evictForgeProjectCaches`.
- `glpat-` redaction already exists (`secret-redaction.ts:68`); 4.3 adds the remaining GitLab token prefixes only.
- `glab` (1.118) flags differ from the spec's mapping table: `glab issue list` uses `-O/--output json` (its `-F` is `--output-format`), `glab mr list`/`repo view` use `-F/--output json`. Always spell `--output json`. MR list payloads carry no pipeline; the MR detail's `head_pipeline.status` does. `…/merge_requests/:iid/changes` is deprecated upstream — use `…/diffs` (paged) plus the MR detail for `sha`.

## Decisions (autonomous defaults, reversible)

- D1 — Capability absence answers the existing payload degradation with forge-neutral copy only where the string is a *reason* (`{available:false, reason}`); route status codes and shapes never change (BACKWARD_COMPATIBILITY.md §2).
- D2 — Discovery warm-up (`warmForgeDiscovery`) runs only in a real server (gated like `warmAgentKnowledge` on `deps.socketHub`) and on an `unref`'d bounded interval; tests never spawn it. The cache path defaults to `join(homedir(), '.cache', 'cez', 'forge-hosts.json')` like `skills-remote.ts`, injectable for tests. No new `CEZ_*` variable.
- D3 — Web origin rule for `ParsedRemote.origin` as stated under Major 2.
- D4 — Old exported names stay as delegates where anything imports them (`evictGithubProjectCaches`, `GH_PR_DIFF_FILE_CAP`, `GH_PR_PATCH_CAP`, re-export shims), so the diff never removes a symbol.
- D5 — GitLab `listPRs` keeps `checks: null` on list rows, hydrated lazily through `listChecks` exactly like GitHub since #664.
- D6 — `glab` is installed by the server installer only through brew; on apt it is attempted and a failure degrades to a one-line hint (it is not in every distro's archive), never failing the install.

## Implementation Plan

Every Step is one commit and carries its own tests. Conventions for all Steps: strict TS, `.ts` import extensions as the surrounding code uses them, zod at every CLI boundary, `execFile`/`spawn` with argument arrays, `CEZ_DRY_RUN=1` keeps working, no new runtime dependency, comments cite `spec 2026-08-10-forge-provider-adapters` or the issue. Run tests through `npm test -- <path>` (never `npx vitest`).

### Phase 1 — Finish the seam (GitHub only, behaviour-preserving)

Acceptance for the phase: a GitHub repo with `gh` and no config behaves byte-identically — same routes, payloads, caches, nav, hints. Checkpoint 1 runs the full gate plus `route-parity`, `bc-route-inventory`, `health-forge`, `contract-parity*`.

#### 1.1 Widen ForgeKind and add optional driver capabilities
- `forge/types.ts`: `ForgeKind = 'github' | 'gitlab'`. Add optional `listComments?(kind, number, opts?: {refresh?}) : Promise<ForgeCommentsData>`, `listChecks?(numbers): Promise<ForgeChecksData>`, `refStatus?(prs, issues): Promise<ForgeRefStatusData>` to `ForgeDriver`.
- Re-home the forge-neutral payload types (`GithubChecksData` → `ForgeChecksData`, `GithubRefStatusData`/`ReferenceStatus` → `ForgeRefStatusData`/`ForgeReferenceStatus`) into `types.ts`, keeping the old names as type aliases exported from `github.ts` and the `server/github.ts` shim.
- Tests: `forge/index.test.ts` type-level case that a driver object may omit every optional method; existing suites green.

#### 1.2 Widen the contract schemas and their narrowing consumers
- `packages/contract/src/health.ts`: `forgeInfoSchema.kind` → `z.enum(['github','gitlab'])`; `backendCheckSchema.name` gains `'glab'`. Mirror `BackendCheck['name']` in `core/backend-detect.ts`.
- `packages/contract/src/projects.ts`: per-project `forge` → the same enum.
- Consumers that narrow on the literal move in the same commit: `web/src/components/project-groups.tsx:558` (`project.forge === 'github'` → forge present), `web/src/lib/git-actions.ts` `ForgeInfo` use. Server keeps emitting only `'github'` in this Step.
- Tests: `contract-parity*.test.ts`, `api-types.test.ts`, web typecheck; a `project-groups` case showing a `gitlab` project keeps the forge item.

#### 1.3 Extract forge/cli.ts shared adapter plumbing
- New `forge/cli.ts`: cwd-scoped `runCli(bin, repoRoot, args, {timeoutMs, maxBuffer})`; `isNotFound(err)` + `notFoundReason(tool)` building the existing ENOENT hints (GitHub text byte-identical: ``gh CLI not found — install it and run `gh auth login` ``); the bounded page loop (`fetchBoundedPages` — deadline + min-page budget + page cap, page-1 rethrow, later-page stop-short) generalized from `fetchTimelinePages`; a keyed stale-while-revalidate cache (`createSwrCache` — fresh hit, in-flight join, serve-stale-and-revalidate, `null` only when cold, LRU bound) generalized from `detectCache`/`detectInflight`.
- Re-home `forge/github.ts` onto it (`gh()`, the seven ENOENT sites, `fetchTimelinePages`, `detectGithub`/`detectGithubCached`). Constants and caps keep their names and values.
- `evictForgeProjectCaches(repoRoot)` clears every per-root cache (list, merge-state, comments, checks, prDiff, refStatus, detect) — fixing the comments-key prefix bug — with `evictGithubProjectCaches` kept as a delegate.
- Tests: new `forge/cli.test.ts` (runner ENOENT mapping, page loop budget/cap/stop-short, SWR cache: two roots never evict each other, expired entry returns stale while revalidating, cold → null). `forge/github.test.ts` unchanged and green. A regression test that eviction now clears comments (fails on `main`).

#### 1.4 Route GET /github and /github/search through the driver
- `server.ts` `githubRoutes`: resolve `resolveForge(await getRepoInfo(repoRoot))`; `null` forge answers the exact unavailable payload the route family uses today (read `fetchGithub`'s no-remote/no-gh answers and keep them byte-identical — reason text may become forge-neutral only where today's text is produced by the route, not by `gh`).
- Listing: if `listIssues`/`listPRs` cannot reproduce `fetchGithub`'s full payload (labelColors, truncation, availability) byte-identically, add an optional `listAll?(opts): Promise<ForgeListData>` (re-homed `GithubData`) and have the GitHub driver implement it with `fetchGithub`; the route uses it.
- `/github/search`: via `forge.searchItems?`; absent → `{available:false, reason, items:[]}` in the existing shape.
- Tests: existing github list/search API tests green; new cases: `null` forge → unavailable payload (no throw), driver without `searchItems` → degraded payload.

#### 1.5 Route GET /github/comments through forge.listComments
- Move `fetchGithubComments` behind `createGithubDriver().listComments`; route calls the driver; missing method → `{available:false, reason, comments:[]}`.
- Tests: `github-comments-api.test.ts` green through the driver; capability-absent degradation.

#### 1.6 Route GET /github/checks through forge.listChecks
- Same for `fetchGithubChecks`; `GH_CHECKS_MAX` cap and the 400s (`missing prs query`/`invalid prs query`) unchanged.
- Tests: `github-checks-api.test.ts` green; capability-absent degradation.

#### 1.7 Route GET /github/ref-status through forge.refStatus
- GitHub driver implements `refStatus` with `fetchGithubRefStatus`; the route calls the driver; absent → `{available:false, reason, recheckAfterMs:null}` (a forge that cannot answer has nothing to recheck). `forgetRefStatus`/`readCachedRefStatuses`/`refNumberFromUrl` stay module helpers (cache-only, harmless for non-GitHub roots).
- Tests: `github-ref-status-api.test.ts`, `ref-status-invalidation.test.ts`, `runs-index-api.test.ts` green; capability-absent degradation.

#### 1.8 Route PR changes and draft-PR creation through the driver
- `GET /github/prs/:number/changes` via `forge.prDiff?` keeping the `GithubPrNotFoundError` → 404 mapping; `POST /runs/:id/pr` via `forge.createPR` (null forge → the existing 409 with `manual: git merge <branch>`); the `refNumberFromUrl`+`forgetRefStatus` follow-up unchanged.
- Tests: `github-pr-changes-api.test.ts`, `forge/github-pr-diff.test.ts`, `forge/draft-pr-autosave.test.ts` green; null-forge 409 case.

#### 1.7-review-fix Type the driver-stub test payloads explicitly
- Appended mid-run: the 1.7 executor's follow-up commit annotating two test stubs with `ForgeChecksData`/`ForgeRefStatusData` so `npm run typecheck` passes (commit `ea6aada9` alone does not typecheck — known bisect gap, recorded in NOTIFY).

#### 1.8-review-fix Keep the pre-seam draft-PR path when no forge resolves
- Found at Phase 1 close: 1.8's null-forge early 409 skipped `createDraftPr`'s final autosave (so the `git merge` hint lost the task's last edits), its actionable "no git remote — add one" text, and the `CEZ_DRY_RUN` fake PR. With no resolved driver, `POST /runs/:id/pr` now calls `createDraftPr` exactly as before the seam.
- Tests: dry-run no-remote worktree → 201 fake PR; non-dry-run no-remote → 409 with the original text.

### Phase 2 — Discovery (still GitHub-only in effect)

#### 2.1 Add forge/discovery.ts with the host ladder and cache
- Well-known map `{ 'github.com': 'github', 'gitlab.com': 'gitlab' }`; `readForgeHostCache(file)` / `writeForgeHostCache(file, map)` — zod `{version:1, hosts: Record<host, 'github'|'gitlab'|'none'>, updatedAt}`, corrupt or absent → empty map, never a throw; atomic tmp+rename write; a read-only or missing directory → write skipped silently.
- Parsers `parseGhAuthHosts(text)` / `parseGlabAuthHosts(text)` over real `gh auth status` / `glab auth status` output (both print to stderr; hosts are the unindented header lines and the `Logged in to <host>` lines). Fixtures captured 2026-09-22 (tokens redacted).
- `warmForgeDiscovery({cacheFile, run})`: probes whichever CLIs exist, merges hosts into the cache, never throws.
- Tests: `forge/discovery.test.ts` — each parser (logged-in, logged-out, multiple hosts, enterprise host), corrupt cache, absent directory, read-only directory, CLI missing.

#### 2.2 Wire discovery into forge/index.ts and the boot warm-up
- Replace `FORGE_HOSTS` with `forgeKindOfHost(host)`: well-known → in-memory cache (loaded synchronously once, refreshed after each warm) → `null`; `'none'` → `null`. `forgeKindOfRemote`, `resolveForge`, `forgeWebRoot` all read it and stay synchronous and I/O-free on the call path.
- `resolveForge` builds the GitHub driver for any `github` host (GitHub Enterprise via `gh auth status`); the `gitlab` branch returns `null` until 3.1.
- Boot: `warmForgeDiscovery()` fire-and-forget beside `warmAgentKnowledge` (gated on `deps.socketHub`), plus an `unref`'d interval (e.g. 10 min); never from a request.
- `GET /api/v1/projects` `repoUrl` widens to any discovered forge's web root (still credential-free, built from the parse).
- Tests: `forge/index.test.ts` — on-prem host present in cache, absent, `'none'`; `forgeKindOfRemote` performs no I/O (spy); `workspace/projects.test.ts` and `health-forge.test.ts` green.

#### 2.3 Carry path and web origin on ParsedRemote
- `ParsedRemote` gains `path` (full project path, `.git` stripped, e.g. `group/sub/repo`) and `origin` (D3). `owner`/`repo` keep their meaning. `forgeWebRoot` = `origin` + `/` + `path`.
- Tests: table over `gitlab.com/group/repo`, `…/group/sub/repo`, 3-level nesting, scp-form, `ssh://…:2222/…`, `http://gitlab.acme.internal:8929/group/repo`, `https://intranet/gitlab/group/repo`, credentials in URL (never in `origin`), plus every existing GitHub case unchanged; assert the built `forgeWebRoot` for each.

#### 2.4 Build the GitHub viewUrl from the parsed origin
- `createGithubDriver(repoRoot, {owner, repo, origin})`; `viewUrl` base = `origin/owner/repo` instead of the `https://github.com` literal.
- Tests: `viewUrl` for github.com (unchanged strings) and an enterprise host.

### Phase 3 — The GitLab adapter (read paths)

All GitLab calls run `glab` with `cwd = repoRoot` through `forge/cli.ts`; `glab api` endpoints use the `:fullpath` placeholder (never a path cezar derived). Every payload is zod-validated; fixtures come from real gitlab.com responses captured 2026-09-22 (public `gitlab-org/cli`), trimmed. `CEZ_DRY_RUN=1` has a mock per method, mirroring GitHub's.

#### 3.1 GitLab driver skeleton with detect and registration
- `forge/gitlab.ts` `createGitlabDriver(repoRoot, parsed)`; `detect()` via `glab repo view --output json` (auth + existence in one call) through the shared SWR cache; caches the project `web_url` and `path_with_namespace` per root; ENOENT → ``glab CLI not found — install the GitLab CLI and run `glab auth login` ``; auth failure → `glab`'s own first line. `resolveForge` returns it for `gitlab` hosts. `evictForgeProjectCaches` covers its caches.
- Tests: `forge/gitlab.test.ts` — available, not installed, not authenticated, dry-run; `health-forge.test.ts` case where a GitLab remote reports `forge.kind: 'gitlab'`.

#### 3.2 GitLab listIssues and listPRs
- `glab issue list --output json --per-page N`, `glab mr list --output json --per-page N`; map to `ForgeItem` (`iid` → `number`, `web_url`, `author.username`, `labels`, `description` capped like GitHub, `user_notes_count`, `draft || work_in_progress` → `isDraft`, `checks: null` per D5). Label colors from `glab api projects/:fullpath/labels`, best-effort. Implement `listAll` too if 1.4 introduced it.
- Tests: fixture → exact `ForgeItem[]`; empty, capped, malformed payloads.

#### 3.3 GitLab listComments with timeline events
- `glab api projects/:fullpath/{issues|merge_requests}/:iid/notes?per_page=100&sort=asc` via the bounded page loop; user notes → `ForgeComment` (`kind:'comment'`), system notes and `resource_label_events` → `ForgeTimelineEvent` through the existing allowlist (labeled/unlabeled, closed/reopened/merged, assigned, renamed where the system note is recognizable), unknown kinds dropped; caps `THREAD_ENTRY_CAP` and the 8 000-char body cap.
- Tests: fixtures producing each mapped kind, an unmapped kind dropped, cap/truncation flag.

#### 3.4 GitLab listChecks and prStatus
- `listChecks(numbers)`: per MR `glab api projects/:fullpath/merge_requests/:iid` → `head_pipeline.status` (`success`→`passing`, `failed`→`failing`, `running|pending|created|waiting_for_resource|preparing|scheduled`→`pending`, `canceled|skipped|manual`→`null`, no pipeline → `null`); bounded concurrency, cap `GH_CHECKS_MAX`.
- `prStatus(branch)`: `glab mr list --source-branch <branch> --all --output json` → newest MR → `ForgePrStatus` (`opened`→`open`, `merged`, `closed`), with checks from its pipeline.
- Tests: every status value incl. no pipeline; branch with no MR → `null`; `glab` failure → `null`.

#### 3.5 GitLab prDiff with forge-neutral caps
- Rename `GH_PR_DIFF_FILE_CAP`/`GH_PR_PATCH_CAP` to `FORGE_PR_DIFF_FILE_CAP`/`FORGE_PR_PATCH_CAP` in a neutral place (old names kept as aliases, D4). GitLab: MR detail for `sha`, then `…/merge_requests/:iid/diffs?per_page=100` pages through the bounded loop; map `new_file`/`deleted_file`/`renamed_file` to statuses, count `+`/`-` lines from `diff`, apply caps; 404 → `GithubPrNotFoundError`-equivalent (the route's existing 404 mapping).
- Tests: diff hitting each cap, renamed/added/deleted files, missing MR → 404 path.

#### 3.6 GitLab searchItems
- `glab issue list --search <q> --all --output json` / `glab mr list --search <q> --all --output json`, capped at `GH_SEARCH_MAX`, `checks: null`, `truncated` when capped.
- Tests: fixture hits, empty result, `glab` failure → `{available:false}`.

#### 3.7 GitLab viewUrl
- Base = cached `web_url` (3.1) else `origin/path` (2.3); `/-/issues/N`, `/-/merge_requests/N`, `/-/tree/<branch>`, `/-/commit/<sha>`; per-segment encoding for branch names with slashes.
- Tests: each kind, branch with slashes, non-root instance (`https://intranet/gitlab/group/repo`).

#### 3.8 Cockpit forge label, icon and copy from health.forge.kind
- Nav item label/icon and route `pageLabel` from `health.forge.kind` (`GitHub`/GitHub icon, `GitLab`/GitLab icon — add a small inline `GitlabIcon` beside `GithubIcon`); `/github` URL and the `forge` gate unchanged.
- `routes/github/github.tsx` unavailable state: title and hint driven by `forge.kind`/`reason` (no hard-coded `gh auth login` for GitLab); "Open all files on GitHub" and similar copy take the forge name. `lib/git-actions.ts` "no supported forge remote (GitHub) detected" → forge-neutral. `components/tools-menu.tsx` `forgeNote` forge-neutral.
- Tests: `nav-items` both kinds; `github.test.tsx` renders a GitLab payload and the GitLab unavailable hint; `git-actions.test.ts`, `tools-menu.test.tsx` updated.

#### 3.9 Forge-neutral task reference chips in the cockpit
- `web/src/lib/tasks-table.ts`: `githubRepoBase` → `forgeRepoBase(remote, kind?)` mirroring the server parse including the 2.3 subgroup/origin rules (well-known hosts only when no kind is given; any host when the server's `forge` kind says so); `synthesizeUrl`/`taskIssueUrl` emit `/-/merge_requests/N` and `/-/issues/N` for `gitlab`. `api/queries.ts` `useProjectRepoBase` passes the project's forge kind (registry `forge` + `repoUrl` preferred, as today). Document the parser-duplication rule (change both copies in one commit) in both `tasks-table.ts` and `forge/index.ts`.
- Tests: `tasks-table.test.ts` — self-managed GitLab subgroup remote → linking chip with `/-/` grammar for MR and issue; every existing GitHub case byte-identical.

### Phase 4 — Write paths and workspace integration

#### 4.1 GitLab draft merge request creation
- `createPR` on the GitLab driver mirroring `createDraftPr`: same autosave/push preflight and base-branch rule (`run.baseBranch` normalized; raw SHA → default branch), then `glab mr create --draft --source-branch <b> --target-branch <base> --title <t> --description <body> --yes`; URL taken from stdout matched against the instance host (`/-/merge_requests/\d+`); one-line human errors for missing `glab`, auth failure, no URL; dry-run fake URL on the instance.
- Tests: success, `glab` missing, auth failure, no-URL-in-output, conflicted-worktree refusal (mirroring `draft-pr-autosave.test.ts`).

#### 4.2 Clone from a GitLab remote
- `server/checkout.ts`: `parseRepoRef()` accepts `owner/repo` (GitHub, unchanged) and full URLs on any discovered forge host (GitLab subgroups allowed in the source path); the single-path-segment **target** rule and `cleanupCheckout`'s ownership proof unchanged (security invariants). Per-kind runner: `gh repo clone` (unchanged, incl. its credential helper) or `glab repo clone <url>`; unknown host → 400. Server validator message and `POST /projects/checkout` shape unchanged except the 400 text naming "a git forge repository".
- Copy: clone dialog title "Clone from a git forge", placeholder accepts a full URL; `app-shell.tsx` menu item and `settings/projects-section.tsx` hint neutral.
- Tests: `checkout.test.ts` GitLab spellings (https, ssh, subgroup), unknown host 400, `glab` missing → 503 hint, cleanup guard refusing everything it refuses today; `clone-project-dialog.test.tsx` copy.

#### 4.3 Host tooling, agent env and redaction for glab
- `core/backend-detect.ts`: `probeGlab()` (`glab auth status`, hint "install the GitLab CLI and run `glab auth login` (only needed for GitLab projects)"), added to `detectEnvironment` checks as `'glab'` (optional, never an error).
- `core/agent-env.ts`: forward `GITLAB_TOKEN`, `GITLAB_HOST`, `GLAB_CONFIG_DIR`, `GITLAB_URI`, `GITLAB_API_HOST` beside `GH_ALLOW_NAMES`.
- `core/secret-redaction.ts`: GitLab prefixes beyond `glpat-`: `gloas-`, `gldt-`, `glrt-`, `glcbt-`, `glptt-`, `glft-`, `glimt-`, `glagent-`, `glsoat-`, `glffct-`, `glwt-`.
- `server-install/steps.ts`: `glab` in the dependency step per D6 (brew install; apt best-effort with a hint), remove hints.
- Tests: redaction table, agent-env allowlist, `steps.test.ts` glab branches, health checks include `glab`.

#### 4.4 Run bookkeeping learns GitLab URL shapes
- `runs/store.ts` `PR_URL_RE`/`ISSUE_URL_RE`/`refUrlRepo`/`CREATED_PR_RE` (and their call sites) learn `https://<host>/<path>/-/merge_requests/N` and `/-/issues/N` on any host, plus `glab mr create`; `runs/task-refs.ts` URL regexes likewise; `refNumberFromUrl` accepts MR URLs. GitHub wording in `web/src/lib/github-task.ts` is unchanged (so the documented coupling needs no edit).
- Tests: `store.test.ts` and `task-refs.test.ts` GitLab URLs incl. subgroups, every GitHub case unchanged.

#### 4.5 Bookmarklet matcher from discovered hosts
- `lib/bookmarklet.ts` builds its matcher from the known forge hosts (github.com always; GitLab hosts from the projects' `repoUrl`s) and matches `/-/merge_requests/N` and `/-/issues/N`; the CSP caveat is recorded as unverified for GitLab (not re-tested against a live instance in this run), and the GitHub form is emitted unchanged.
- Tests: generator for both forges; GitHub output byte-identical.

#### 4.6 GitHub-event automations require a GitHub forge
- `server.ts`: `GET /automations` `available`, the manual check, and boot `registerAutomationProject` decide "GitHub events are possible here" from `forgeKindOfRemote(remote) === 'github'` instead of `parsed.host === 'github.com'` / "any forge". Reason copy for a GitLab project: "GitHub automations need a GitHub remote". No route, status code, schema or nav change; schedule automations untouched.
- Tests: `automations-api`/`automations-gate` — a GitLab-remote project answers `available:false` for the GitHub kind, schedule create still succeeds, every existing case unchanged; GitHub Enterprise host counts as GitHub.

#### 4.7 Documentation for the second forge
- `AGENTS.md` (Zero config forge sentence; GitHub-integration routing row names `forge/` and GitLab), `BACKWARD_COMPATIBILITY.md` §2 (health `forge.kind`/`checks[].name` widen, projects `forge?`/`repoUrl?` widen, ref-status/merge degrade for GitLab, automations availability note), README prerequisites (`gh` or `glab`), `docs/reference.md` if it names `gh` as the only forge CLI. No env var added (D2), so `.env.example` is unchanged.
- Tests: `bc-route-inventory.test.ts` green; docs-only.

## Risks

- Phase 1 is a refactor of 2 952 lines of working GitHub code; any payload delta is a bug — mitigated by keeping `forge/github.test.ts` untouched and asserting byte-identity at checkpoint 1.
- Cross-cutting (27 files): each Step is revert-clean; Phase 3/4 only add code paths for a forge that previously had none.
- No live self-managed GitLab instance is available; GitLab behaviour is proven by fixtures from real gitlab.com responses, not end-to-end against a server. The bookmarklet CSP caveat is unverified.
- Known flaky baseline test: `automations/store.test.ts` "falls back to the age rule for a lock whose pid cannot be read" fails under full-suite load on `main` and passes alone (observed 2026-09-22).

## External References

None (`--skill-url` not passed).
