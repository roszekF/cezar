# Final gate — spec complete (31 / 31 rows done)

**When:** 2026-09-22T17:53:57Z
**Head (first gate run):** `1a1260f8` · **Head after the review fixes:** `e340385d` · **Base:** `fork/main` @ `4763447f`

## Full validation gate (`.ai/agentic.config.json` → `validation.commands`), in order

| Command | Result | Evidence |
|---|---|---|
| `npm run typecheck` | ✅ pass | contract, api-client, server, web |
| `npm test` | ✅ pass | **398 files, 7 628 / 7 628** (first run of this gate had 2 failures → one was a real regression, fixed as 4.5-ds-fix `1a1260f8`; the other was the known `automations/store.test.ts` load flake, green on the rerun) |
| `npm run test:unit` | ✅ pass | 36 / 36 |
| `npm run build` | ✅ pass | server tsc + vite + `check:pack` tarball gate |
| `npm run test:package` | ✅ pass | 16 / 16 — the packed tarball installs and runs the CLI |

## Design-system / style pass
The repo's style compliance is a test, not a separate command: `packages/web/src/design-guardian.test.ts` (raw hex, bg-white/black, native dialogs, `dark:` variants, fixture rules) runs inside `npm test`. It **failed** on the first gate run — the Step 4.5 tests asserted the generated bookmarklet's native-dialog call verbatim and the rule scans test sources too. Fixed as Step `4.5-ds-fix` (`1a1260f8`, assertions now pin the message text); guardian green. No residual findings.

## Integration suite (`npm run test:e2e`, agent-browser, per AGENTS.md § Validation)
⚠️ **Fails on this machine, on the branch and on `main` alike.**

| Run | Result |
|---|---|
| Branch, full suite (checkpoint 2) | 33 failed / 186 passed / 6 skipped |
| Branch, full suite (final gate) | 42 failed / 177 passed / 6 skipped |
| `main` @ 4763447f, full suite (checkpoint 2) | 35 failed / 184 passed |
| `main` @ 4763447f, full suite (final gate) | 37 failed / 182 passed |

The failure sets are unstable run to run on both sides (same specs, different subsets), dominated by `agent-browser` waits timing out and by `SocketError: other side closed` on the test runner's own `fetch` — a keep-alive race in the harness, not an app error (the server's log is clean and later specs in the same run pass).

**Per-test discipline instead of an aggregate:** exactly one spec failed in BOTH branch runs and NEITHER `main` run — `composer-defaults.e2e.ts`. Isolated re-runs settle it: **branch 5/5 pass, `main` 4/5 pass** (the one `main` failure is the same socket reset). No spec fails on the branch and passes reliably on `main`.

**Limit, stated plainly:** this machine cannot produce a green e2e baseline, so the suite gives no signal beyond "no worse than `main`". The forge-specific behaviour was verified instead by a real-browser pass on dry-run GitHub and GitLab projects (checkpoints 5 and 6, screenshots on the PR) and by 7 628 unit/component tests.

## Not verified anywhere in this run
- A **live GitLab instance** (gitlab.com or self-managed): every GitLab path is exercised through fixtures captured from real gitlab.com REST responses and fake `glab` binaries. `glab mr create`, `glab repo clone` and the credential helper have never run against a real server here.
- The **bookmarklet CSP caveat** on GitLab (documented as unverified in `lib/bookmarklet.ts`).
- `server-install` `glab` installation on a real apt/brew host (unit-tested only).


## Authoritative review pass (end of run) — 2026-09-22T18:35:24Z

Two reviewers covered the diff (100 files, ~8 500 insertions): server/forge + routes + core + installer + contract; and cockpit + run bookkeeping + docs. Both verdicts were **request changes**. Every finding below was re-verified in the code by the orchestrator before being actioned.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | major | Forge tab/title/hand-off read `health.forge.kind`, which always describes the BOOT project — a GitLab project in a GitHub-boot workspace rendered "GitHub"/"Pull requests", the `gh auth login` hint, and wrote "Address GitHub pull request #N" for an MR | `13e2fbc1` — new `useForgeKind()` resolving the VIEWED project from the registry, with the same #526 guard `useProjectRepoBase` uses |
| 2 | major | `runs/store.ts` GitLab URL patterns pinned to `https` while `parseRemote` keeps `http`+port for on-prem, and `task-refs.ts` accepts both — the two halves disagreed about the same run | `ee513720` |
| 3 | major | The #945 foreign-reference guard was inert on GitLab: its only handle producer shells `gh repo view`, so a GitLab task adopted another project's MR as its subject | `21029c40` — handle derived from the project's own remote for a discovered forge |
| 4 | major | **Introduced by Step 4.6**: widening the automations gate to `forgeKindOfRemote === 'github'` armed the poller for GitHub **Enterprise**, but the poller passes no host and filters on `https://api.github.com/repos/<owner>/<repo>` — a GHE project would have polled the same-named github.com repo and launched runs from a stranger's issues | `92973497` — one shared `githubAutomationsBlocker`, github.com only, with the poller's limitation named in its doc |
| 5 | major | `probeGlab` ran the networked `glab auth status` (10 s) inside the health snapshot — offline, `/api/v1/health` could blow the bookmarklet's latency budget | `50b6bfd1` — two local `glab config get` reads at 2.5 s; live auth stays in the off-path warm-up |
| 6 | major | `fetchGitlabChecks` fanned out 100 per-MR calls with no shared budget (minutes of request time, 100 processes) | `28636fcf` — one deadline, partial glyphs returned |
| 7 | minor→major for GHE | Discovery map loaded lazily inside a request; until the first probe a GHE project's `/github*` routes degraded where they previously served live data | `cccbd9fd` — eager load at `createApp`, remaining window documented in BC |
| 8 | minor | Bookmarklet host escaping covered `.` only — an IPv6 instance host became a character class, or broke the generated program | `b614b2d8` |
| — | — | Collision between two parallel fixes: the new `arm-repo-handle` test's bare mock lost `TIMELINE_BUDGET_MS` once `gitlab.ts` imported it | `e340385d` |

**Gate after the fixes:** `npm run typecheck` ✅ · `npm test` ✅ **398 files, 7 665 / 7 665** · `npm run test:unit` ✅ 36/36 · `npm run build` ✅ · `npm run test:package` ✅ 16/16. Each fix's tests were verified to fail against the pre-fix behaviour.

**Deferred, recorded rather than fixed** (none blocking; all pre-existing or out of this diff's scope):
- `runs/store.ts` still cannot see GitHub **Enterprise** PR/issue URLs (its GitHub alternative is pinned to github.com) — pre-existing, but 2.4 makes GHE a named configuration, so it deserves a follow-up.
- `forge/github.ts`'s `PR_URL_RE` is github.com-only, so a GHE draft PR is created but reported as "no PR URL" — pre-existing run-lifecycle gap, same follow-up.
- Discovery never demotes a host after `gh/glab auth logout` (no `'none'` is ever written) and rewrites the cache every 10 min even when unchanged.
- `evictForgeProjectCaches` has no production caller (project removal/re-point is not wired to it).
- Each forge route spawns `getRepoInfo` (3 `git` processes) per request; `/github/ref-status` is polled on an interval.
- GitLab thread assembly can spend up to 2× the GitHub timeline budget (three loops, one budget each).
- `handoff.ts`'s agent-facing marker instruction still says "GitHub pull request or issue" on a GitLab project (copy only; markers are numeric).
