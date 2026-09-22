import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same technique as github.test.ts: `glab()` builds its runner from `promisify(execFile)` at module
// load, so every probe below is driven through this mock — no real `glab` on the box, no network.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import type { RunRecord } from '../../runs/store.ts';
import { evictForgeProjectCaches } from './cli.ts';
import { parseRemote, type ParsedRemote } from './index.ts';
import {
  GLAB_NOT_FOUND_REASON,
  createGitlabDriver,
  detectGitlabCached,
  gitlabProjectPath,
  gitlabProjectWebUrl,
} from './gitlab.ts';

/** `glab repo view --output json`, trimmed from a real gitlab.com response (captured 2026-09-22)
 *  to the identity fields plus a few extras the schema must strip; values neutralized. */
const PROJECT_JSON = JSON.stringify({
  id: 1001,
  name: 'demo',
  path_with_namespace: 'acme/demo',
  web_url: 'https://gitlab.com/acme/demo',
  default_branch: 'main',
  visibility: 'public',
  namespace: { id: 7, name: 'acme', path: 'acme', kind: 'group', full_path: 'acme' },
});

/** A realistic `glab` auth failure: the API client's error line, as glab prints it to stderr. */
const GLAB_401 = 'GET https://gitlab.com/api/v4/projects/acme%2Fdemo: 401 {message: 401 Unauthorized}';

type Callback = (err: unknown, value?: unknown) => void;

const reply = (fn: (cb: Callback) => void) =>
  execFileMock.mockImplementation((...args: unknown[]) => fn(args[args.length - 1] as Callback));

const glabOk = (stdout = PROJECT_JSON) => reply((cb) => cb(null, { stdout, stderr: '' }));

const parsed = (): ParsedRemote => {
  const p = parseRemote('git@gitlab.com:acme/demo.git');
  if (!p) throw new Error('fixture remote must parse');
  return p;
};

let rootSeq = 0;
/** Each case gets its own root, so the module-level caches never leak between cases. */
const freshRoot = () => `/repo/gitlab-detect-${++rootSeq}`;

describe('GitLab driver — detect', () => {
  const CACHE_MS = 60_000; // mirrors the constant in gitlab.ts

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit the probe we're testing
    vi.useFakeTimers();
    vi.setSystemTime(0);
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('is kind gitlab and probes `glab repo view --output json` in the repo root', async () => {
    glabOk();
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    expect(driver.kind).toBe('gitlab');
    expect(await driver.detect()).toEqual({ available: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = execFileMock.mock.calls[0] as [string, string[], { cwd: string; timeout: number }];
    expect(bin).toBe('glab');
    expect(args).toEqual(['repo', 'view', '--output', 'json']);
    expect(opts.cwd).toBe(root);
    expect(opts.timeout).toBe(5_000);
  });

  it('caches the project web_url and path_with_namespace per root on success', async () => {
    glabOk();
    const root = freshRoot();
    expect(gitlabProjectWebUrl(root)).toBeNull();
    await createGitlabDriver(root, parsed()).detect();
    expect(gitlabProjectWebUrl(root)).toBe('https://gitlab.com/acme/demo');
    expect(gitlabProjectPath(root)).toBe('acme/demo');
  });

  it('reports the install hint verbatim when glab is not installed (ENOENT)', async () => {
    reply((cb) => cb(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })));
    const result = await createGitlabDriver(freshRoot(), parsed()).detect();
    expect(result).toEqual({
      available: false,
      reason: 'glab CLI not found — install the GitLab CLI and run `glab auth login`',
    });
    expect(result.reason).toBe(GLAB_NOT_FOUND_REASON);
  });

  it("reports glab's own first stderr line when it is not authenticated", async () => {
    reply((cb) =>
      cb(
        Object.assign(new Error(`Command failed: glab repo view --output json\n${GLAB_401}\n`), {
          code: 1,
          stderr: `\n${GLAB_401}\nRun glab auth login to authenticate.\n`,
        }),
      ),
    );
    const root = freshRoot();
    expect(await createGitlabDriver(root, parsed()).detect()).toEqual({ available: false, reason: GLAB_401 });
    expect(gitlabProjectWebUrl(root)).toBeNull();
  });

  it('falls back to the error message, then to "glab failed", when there is no stderr', async () => {
    reply((cb) => cb(Object.assign(new Error('glab timed out'), { code: 1, stderr: '' })));
    expect(await createGitlabDriver(freshRoot(), parsed()).detect()).toEqual({ available: false, reason: 'glab timed out' });

    execFileMock.mockReset();
    reply((cb) => cb(Object.assign(new Error(''), { code: 1 })));
    expect(await createGitlabDriver(freshRoot(), parsed()).detect()).toEqual({ available: false, reason: 'glab failed' });
  });

  it('answers unavailable with a clear reason for malformed or unexpected JSON', async () => {
    glabOk('not json');
    const root = freshRoot();
    expect(await createGitlabDriver(root, parsed()).detect()).toEqual({
      available: false,
      reason: 'glab repo view returned an unexpected response',
    });
    expect(gitlabProjectWebUrl(root)).toBeNull();

    execFileMock.mockReset();
    glabOk(JSON.stringify({ id: 1, name: 'demo' })); // valid JSON, no identity fields
    expect((await createGitlabDriver(freshRoot(), parsed()).detect()).available).toBe(false);
  });

  it('is available under CEZ_DRY_RUN=1 without shelling out', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    expect(await driver.detect()).toEqual({ available: true });
    expect(driver.detectCached()).toEqual({ available: true });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('detectCached is null when cold, then warm — and never shells out on the read', async () => {
    glabOk();
    const root = freshRoot();
    expect(detectGitlabCached(root)).toBeNull();
    await vi.advanceTimersByTimeAsync(0); // the fire-and-forget probe settles
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(detectGitlabCached(root)).toEqual({ available: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('serves the stale answer while revalidating once the cache expires (#508)', async () => {
    glabOk();
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    expect(await driver.detect()).toEqual({ available: true });

    vi.setSystemTime(CACHE_MS + 1);
    expect(driver.detectCached()).toEqual({ available: true }); // stale, not null
    await vi.advanceTimersByTimeAsync(0);
    expect(execFileMock).toHaveBeenCalledTimes(2); // exactly one background revalidation
  });

  it('probes once when a cold read is followed by an awaited detect', async () => {
    glabOk();
    const root = freshRoot();
    expect(detectGitlabCached(root)).toBeNull();
    const awaited = createGitlabDriver(root, parsed()).detect();
    await vi.advanceTimersByTimeAsync(0);
    expect(await awaited).toEqual({ available: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('evictForgeProjectCaches drops the probe and the project identity for that root only', async () => {
    glabOk();
    const root = freshRoot();
    const other = freshRoot();
    await createGitlabDriver(root, parsed()).detect();
    await createGitlabDriver(other, parsed()).detect();

    evictForgeProjectCaches(root);
    expect(gitlabProjectWebUrl(root)).toBeNull();
    expect(detectGitlabCached(root)).toBeNull(); // cold again
    expect(detectGitlabCached(other)).toEqual({ available: true });
    expect(gitlabProjectWebUrl(other)).toBe('https://gitlab.com/acme/demo');
  });
});

describe('GitLab driver — skeleton members (later steps implement them)', () => {
  it('has no MR probe or links, and refuses merge-request creation', async () => {
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.prStatus('feature')).toBeNull();
    expect(driver.viewUrl('repo', '')).toBeNull();
    expect(
      await driver.createPR({ repoRoot: '/repo', run: {} as RunRecord, handoffText: '' }),
    ).toEqual({ ok: false, error: 'Merge request creation is not implemented yet for GitLab' });
  });

  it('leaves the optional capabilities absent, so the routes degrade in the payload', () => {
    const driver = createGitlabDriver(freshRoot(), parsed());
    // listAll is now implemented (Step 3.2) — everything else still lands on later Steps.
    expect(driver.listComments).toBeUndefined();
    expect(driver.listChecks).toBeUndefined();
    expect(driver.refStatus).toBeUndefined();
    expect(driver.searchItems).toBeUndefined();
    expect(driver.prDiff).toBeUndefined();
    expect(driver.prMergeState).toBeUndefined();
    expect(driver.mergePR).toBeUndefined();
  });
});

// ---- listIssues / listPRs / listAll (Step 3.2) ------------------------------------------------
// Fixtures trimmed from real `glab issue/mr list --output json` output against gitlab.com's own
// `gitlab-org/cli` project (captured 2026-09-22), usernames/emails/avatars neutralized. Extra
// fields the real payload carries (`id`, `project_id`, `state`, …) are kept on a couple of rows to
// prove the schema strips them rather than choking on them.
const ISSUES_JSON = JSON.stringify([
  {
    id: 203839552,
    iid: 8564,
    project_id: 34675721,
    title: 'mr note publish --reviewer-state silently does nothing on your own merge request',
    description: 'Publishing your own pending review comments with --reviewer-state silently drops the field.',
    state: 'opened',
    created_at: '2026-09-21T14:52:48.317Z',
    labels: ['type::bug', 'quick win'],
    author: { id: 111, username: 'alice', name: 'Alice Example' },
    user_notes_count: 2,
    web_url: 'https://gitlab.com/acme/demo/-/issues/8564',
  },
  {
    iid: 8563,
    title: 'Support listing and discarding pending review comments',
    description: null,
    created_at: '2026-09-21T12:52:48.714Z',
    labels: [],
    author: { id: 222, username: 'bob' },
    user_notes_count: 0,
    web_url: 'https://gitlab.com/acme/demo/-/issues/8563',
  },
]);

const ISSUES_ITEMS = [
  {
    kind: 'issue',
    number: 8564,
    title: 'mr note publish --reviewer-state silently does nothing on your own merge request',
    author: 'alice',
    createdAt: '2026-09-21T14:52:48.317Z',
    labels: ['type::bug', 'quick win'],
    body: 'Publishing your own pending review comments with --reviewer-state silently drops the field.',
    url: 'https://gitlab.com/acme/demo/-/issues/8564',
    comments: 2,
  },
  {
    kind: 'issue',
    number: 8563,
    title: 'Support listing and discarding pending review comments',
    author: 'bob',
    createdAt: '2026-09-21T12:52:48.714Z',
    labels: [],
    body: '',
    url: 'https://gitlab.com/acme/demo/-/issues/8563',
    comments: 0,
  },
];

const MRS_JSON = JSON.stringify([
  {
    id: 536356170,
    iid: 3950,
    project_id: 34675721,
    title: 'feat: delegate path ownership to domain teams without Maintainer',
    description: 'Adds a code owner group for the delegated paths and documents the access model.',
    state: 'opened',
    created_at: '2026-09-21T19:16:00.183Z',
    labels: ['type::maintenance'],
    author: { id: 111, username: 'alice' },
    user_notes_count: 2,
    web_url: 'https://gitlab.com/acme/demo/-/merge_requests/3950',
    draft: true,
    work_in_progress: false,
  },
  {
    // Legacy MRs that predate the `draft` field still only set `work_in_progress`.
    iid: 3948,
    title: 'docs(agents): drop the removed gen-config command',
    description: 'Removes a stale command reference from AGENTS.md.',
    created_at: '2026-09-21T16:38:16.412Z',
    labels: [],
    author: { id: 333, username: 'carol' },
    user_notes_count: 1,
    web_url: 'https://gitlab.com/acme/demo/-/merge_requests/3948',
    draft: false,
    work_in_progress: true,
  },
  {
    iid: 3945,
    title: 'test(mr): scope the mr note publish integration test to API contract',
    description: '',
    created_at: '2026-09-21T14:17:10.114Z',
    labels: [],
    author: null,
    user_notes_count: 4,
    web_url: 'https://gitlab.com/acme/demo/-/merge_requests/3945',
    draft: false,
    work_in_progress: false,
  },
]);

const MRS_ITEMS = [
  {
    kind: 'pr',
    number: 3950,
    title: 'feat: delegate path ownership to domain teams without Maintainer',
    author: 'alice',
    createdAt: '2026-09-21T19:16:00.183Z',
    labels: ['type::maintenance'],
    body: 'Adds a code owner group for the delegated paths and documents the access model.',
    url: 'https://gitlab.com/acme/demo/-/merge_requests/3950',
    comments: 2,
    isDraft: true,
    checks: null,
  },
  {
    kind: 'pr',
    number: 3948,
    title: 'docs(agents): drop the removed gen-config command',
    author: 'carol',
    createdAt: '2026-09-21T16:38:16.412Z',
    labels: [],
    body: 'Removes a stale command reference from AGENTS.md.',
    url: 'https://gitlab.com/acme/demo/-/merge_requests/3948',
    comments: 1,
    isDraft: true, // legacy `work_in_progress`, no `draft` field set
    checks: null,
  },
  {
    kind: 'pr',
    number: 3945,
    title: 'test(mr): scope the mr note publish integration test to API contract',
    author: '?',
    createdAt: '2026-09-21T14:17:10.114Z',
    labels: [],
    body: '',
    url: 'https://gitlab.com/acme/demo/-/merge_requests/3945',
    comments: 4,
    isDraft: false,
    checks: null,
  },
];

const LABELS_JSON = JSON.stringify([
  { name: 'type::bug', color: '#d73a4a' },
  { name: 'type::maintenance', color: '#6699cc' },
]);

/** Routes `glab <cmd> …` calls by their first argument (`issue` / `mr` / `api`) to a canned
 *  stdout, or a stderr-carrying failure when the case wants one to fail. A command with no
 *  handler answers a plain command failure — the labels-endpoint-failure case relies on this. */
function routeGlab(handlers: Partial<Record<string, string | { fail: string }>>) {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const cliArgs = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as Callback;
    const handler = handlers[cliArgs[0] ?? ''];
    if (handler === undefined) {
      cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: 'glab: unknown command\n' }));
      return;
    }
    if (typeof handler === 'string') {
      cb(null, { stdout: handler, stderr: '' });
      return;
    }
    cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: `${handler.fail}\n` }));
  });
}

/** Every case in this block gets its own root, and every arg-based call site is captured, so
 *  cases never leak into each other through the module-level list cache. */
describe('GitLab driver — listIssues / listPRs / listAll', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps a fixture issue list to the exact ForgeItem[] (iid → number, extras stripped)', async () => {
    routeGlab({ issue: ISSUES_JSON, mr: '[]', api: LABELS_JSON });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listIssues()).toEqual(ISSUES_ITEMS);
  });

  it('maps a fixture MR list, draft via `draft` and via legacy `work_in_progress`', async () => {
    routeGlab({ issue: '[]', mr: MRS_JSON, api: LABELS_JSON });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listPRs()).toEqual(MRS_ITEMS);
  });

  it('listAll serves the whole payload — repo, syncedAt, both sets and label colors', async () => {
    routeGlab({ issue: ISSUES_JSON, mr: MRS_JSON, api: LABELS_JSON });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listAll!();
    expect(data).toEqual({
      available: true,
      repo: 'acme/demo',
      syncedAt: expect.any(String),
      issues: ISSUES_ITEMS,
      prs: MRS_ITEMS,
      labelColors: { 'type::bug': 'd73a4a', 'type::maintenance': '6699cc' },
    });
  });

  it('an empty issue and MR list answers empty arrays, still available', async () => {
    routeGlab({ issue: '[]', mr: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listAll!()).toEqual({
      available: true,
      repo: 'acme/demo',
      syncedAt: expect.any(String),
      issues: [],
      prs: [],
      labelColors: {},
    });
  });

  it('clamps a limit above the per-page ceiling and passes it to both `glab` calls', async () => {
    routeGlab({ issue: '[]', mr: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    await driver.listAll!({ limit: 5_000 });
    const issueCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'issue');
    const mrCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'mr');
    expect(issueCall?.[1]).toEqual(['issue', 'list', '--output', 'json', '--per-page', '100']);
    expect(mrCall?.[1]).toEqual(['mr', 'list', '--output', 'json', '--per-page', '100']);
  });

  it('a malformed issue list answers unavailable with a clear reason', async () => {
    routeGlab({ issue: 'not json', mr: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listAll!()).toEqual({
      available: false,
      reason: 'glab issue list returned an unexpected response',
      issues: [],
      prs: [],
    });
  });

  it('a malformed MR list answers unavailable with a clear reason', async () => {
    routeGlab({ issue: '[]', mr: JSON.stringify([{ iid: 'not-a-number' }]), api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listAll!()).toEqual({
      available: false,
      reason: 'glab mr list returned an unexpected response',
      issues: [],
      prs: [],
    });
  });

  it('a glab CLI failure on the list calls answers unavailable with its own first stderr line', async () => {
    routeGlab({ issue: { fail: GLAB_401 }, mr: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listAll!()).toEqual({ available: false, reason: GLAB_401, issues: [], prs: [] });
  });

  it('a labels endpoint failure leaves the list available without labelColors', async () => {
    routeGlab({ issue: ISSUES_JSON, mr: MRS_JSON }); // no `api` handler — labels call fails
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listAll!();
    expect(data.available).toBe(true);
    expect(data.issues).toEqual(ISSUES_ITEMS);
    expect(data.labelColors).toBeUndefined();
  });

  it('caches the listing per root; refresh bypasses it', async () => {
    routeGlab({ issue: ISSUES_JSON, mr: '[]', api: '[]' });
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    const first = await driver.listAll!();
    expect(first.issues).toHaveLength(2);

    routeGlab({ issue: '[]', mr: '[]', api: '[]' }); // the "server" changed underneath the cache
    expect(await driver.listAll!()).toEqual(first); // served from cache, not refetched

    const refreshed = await driver.listAll!({ refresh: true });
    expect(refreshed.issues).toEqual([]);
  });

  it('is available under CEZ_DRY_RUN=1 with a demo catalog, without shelling out', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listAll!();
    expect(data.available).toBe(true);
    expect(data.repo).toBe('demo/demo');
    expect(data.issues).toHaveLength(1);
    expect(data.prs).toEqual([expect.objectContaining({ isDraft: true, checks: null, url: expect.stringContaining('gitlab.com/demo/demo') })]);
    expect(await driver.listIssues()).toEqual(data.issues);
    expect(await driver.listPRs()).toEqual(data.prs);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
