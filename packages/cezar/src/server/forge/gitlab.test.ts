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
  it('lists nothing, has no MR probe or links, and refuses merge-request creation', async () => {
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listIssues()).toEqual([]);
    expect(await driver.listPRs()).toEqual([]);
    expect(await driver.prStatus('feature')).toBeNull();
    expect(driver.viewUrl('repo', '')).toBeNull();
    expect(
      await driver.createPR({ repoRoot: '/repo', run: {} as RunRecord, handoffText: '' }),
    ).toEqual({ ok: false, error: 'Merge request creation is not implemented yet for GitLab' });
  });

  it('leaves the optional capabilities absent, so the routes degrade in the payload', () => {
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(driver.listAll).toBeUndefined();
    expect(driver.listComments).toBeUndefined();
    expect(driver.listChecks).toBeUndefined();
    expect(driver.refStatus).toBeUndefined();
    expect(driver.searchItems).toBeUndefined();
    expect(driver.prDiff).toBeUndefined();
    expect(driver.prMergeState).toBeUndefined();
    expect(driver.mergePR).toBeUndefined();
  });
});
