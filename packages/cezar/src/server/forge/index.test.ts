import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoInfo } from '../git.ts';
import {
  __setForgeHostCacheFileForTests,
  __setForgeHostsForTests,
  forgeKindOfHost,
  forgeKindOfRemote,
  forgeWebRoot,
  refreshForgeDiscovery,
  forgePrDiff,
  forgeRefStatus,
  listForgeChecks,
  listForgeComments,
  listForgeItems,
  NO_FORGE_REASON,
  parseRemote,
  resolveForge,
  searchForgeItems,
} from './index.ts';
import type { ForgeChecksData, ForgeDriver, ForgeItem, ForgePrDiffResult, ForgeRefStatusData } from './types.ts';

// Pass-through spies, so the discovery cases below can assert the classification call path does
// no file read and spawns nothing (spec 2026-08-10-forge-provider-adapters § Forge discovery).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn(actual.spawn) };
});

/** Forge resolution (spec §"Forge-driver seam"): remote host → driver | null. */

const info = (remote?: string): RepoInfo => ({ root: '/repo', branch: 'main', remote });

describe('parseRemote', () => {
  it.each([
    ['https://github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://github.com/acme/demo', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://user:token@github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['git@github.com:acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['ssh://git@github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['ssh://git@github.com:2222/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['git://github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://GitHub.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://github.com/acme/demo/', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['git@gitlab.com:group/sub/project.git', { host: 'gitlab.com', owner: 'sub', repo: 'project' }],
  ])('parses %s', (remote, expected) => {
    expect(parseRemote(remote)).toEqual(expected);
  });

  it.each([
    ['/srv/git/demo.git'], // local bare path — not a forge
    ['../relative/path'],
    ['https://github.com/only-owner'],
    [''],
  ])('rejects %s', (remote) => {
    expect(parseRemote(remote)).toBeNull();
  });
});

describe('forgeKindOfRemote', () => {
  // The registry probe's classification (#698) — same host table as resolveForge,
  // but string-only: no driver, no repo root, no `gh`.
  it.each([
    ['https://github.com/acme/demo.git', 'github'],
    ['git@github.com:acme/demo.git', 'github'],
    ['git@gitlab.com:acme/demo.git', 'gitlab'], // well-known, even with an empty discovery map
    ['https://git.example.com/acme/demo.git', null],
    ['/srv/git/demo.git', null],
    [undefined, null],
  ])('classifies %s as %s', (remote, expected) => {
    expect(forgeKindOfRemote(remote)).toBe(expected);
  });
});

describe('resolveForge', () => {
  it('maps a github.com https remote to the GitHub driver', () => {
    expect(resolveForge(info('https://github.com/acme/demo.git'))?.kind).toBe('github');
  });

  it('maps a github.com scp-like remote to the GitHub driver', () => {
    expect(resolveForge(info('git@github.com:acme/demo.git'))?.kind).toBe('github');
  });

  it('returns null for a gitlab.com remote (the GitLab driver lands in Step 3.1)', () => {
    expect(resolveForge(info('git@gitlab.com:acme/demo.git'))).toBeNull();
  });

  it('returns null for a self-hosted host', () => {
    expect(resolveForge(info('https://git.example.com/acme/demo.git'))).toBeNull();
  });

  it('returns null when the repo has no remote', () => {
    expect(resolveForge(info(undefined))).toBeNull();
  });

  it('returns null when not in a git repo at all', () => {
    expect(resolveForge(null)).toBeNull();
  });

  it('returns null for a local-path remote', () => {
    expect(resolveForge(info('/srv/git/demo.git'))).toBeNull();
  });
});

describe('forge discovery in the host ladder', () => {
  // Spec 2026-08-10-forge-provider-adapters § Forge discovery: well-known → in-memory discovery
  // map → null, and the map is the only thing an on-prem host can be classified from.
  afterEach(() => {
    __setForgeHostsForTests(null);
    __setForgeHostCacheFileForTests(null);
  });

  it('classifies an on-prem gitlab host from the discovery map, with a web root but no driver yet', () => {
    __setForgeHostsForTests({ 'gitlab.acme.internal': 'gitlab' });
    const remote = 'git@gitlab.acme.internal:platform/api.git';
    expect(forgeKindOfRemote(remote)).toBe('gitlab');
    expect(forgeWebRoot(remote)).toBe('https://gitlab.acme.internal/platform/api');
    expect(resolveForge(info(remote))).toBeNull();
  });

  it('builds the GitHub driver for a GitHub Enterprise host from the discovery map', () => {
    __setForgeHostsForTests({ 'github.acme.internal': 'github' });
    const remote = 'https://github.acme.internal/platform/api.git';
    expect(forgeKindOfRemote(remote)).toBe('github');
    expect(forgeWebRoot(remote)).toBe('https://github.acme.internal/platform/api');
    expect(resolveForge(info(remote))?.kind).toBe('github');
  });

  it('answers null for a host absent from the map', () => {
    __setForgeHostsForTests({ 'gitlab.acme.internal': 'gitlab' });
    const remote = 'git@git.other.internal:platform/api.git';
    expect(forgeKindOfRemote(remote)).toBeNull();
    expect(forgeWebRoot(remote)).toBeNull();
    expect(resolveForge(info(remote))).toBeNull();
  });

  it("answers null for a host recorded as 'none'", () => {
    __setForgeHostsForTests({ 'git.acme.internal': 'none' });
    expect(forgeKindOfHost('git.acme.internal')).toBeNull();
    expect(forgeKindOfRemote('git@git.acme.internal:platform/api.git')).toBeNull();
  });

  it('keeps the well-known hosts with an empty map, case-insensitively', () => {
    __setForgeHostsForTests({});
    expect(forgeKindOfHost('GitLab.com')).toBe('gitlab');
    expect(forgeKindOfHost('github.com')).toBe('github');
  });

  describe('with a cache file', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cez-forge-hosts-'));
      vi.mocked(fs.readFileSync).mockClear();
      vi.mocked(childProcess.execFile).mockClear();
      vi.mocked(childProcess.spawn).mockClear();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const writeCache = (file: string, hosts: Record<string, string>): void =>
      writeFileSync(file, JSON.stringify({ version: 1, hosts, updatedAt: '2026-09-22T00:00:00.000Z' }));

    it('loads the cache once, lazily, and classifies with no further I/O', () => {
      const file = join(dir, 'forge-hosts.json');
      writeCache(file, { 'gitlab.acme.internal': 'gitlab' });
      __setForgeHostCacheFileForTests(file);
      expect(fs.readFileSync).not.toHaveBeenCalled(); // nothing read until first use

      expect(forgeKindOfRemote('git@gitlab.acme.internal:platform/api.git')).toBe('gitlab');
      expect(vi.mocked(fs.readFileSync).mock.calls.filter(([p]) => p === file)).toHaveLength(1);

      vi.mocked(fs.readFileSync).mockClear();
      for (let i = 0; i < 5; i++) {
        forgeKindOfRemote('git@gitlab.acme.internal:platform/api.git');
        forgeKindOfRemote('https://github.com/acme/demo.git');
        forgeWebRoot('git@git.other.internal:platform/api.git');
      }
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(childProcess.execFile).not.toHaveBeenCalled();
      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('treats a missing or corrupt cache file as an empty map', () => {
      __setForgeHostCacheFileForTests(join(dir, 'absent.json'));
      expect(forgeKindOfHost('gitlab.acme.internal')).toBeNull();
      const corrupt = join(dir, 'corrupt.json');
      writeFileSync(corrupt, '{not json');
      __setForgeHostCacheFileForTests(corrupt);
      expect(forgeKindOfHost('gitlab.acme.internal')).toBeNull();
      expect(forgeKindOfHost('gitlab.com')).toBe('gitlab');
    });

    it('swaps in the map a warm-up returns', async () => {
      const file = join(dir, 'forge-hosts.json');
      __setForgeHostCacheFileForTests(file);
      expect(forgeKindOfHost('github.acme.internal')).toBeNull();
      await refreshForgeDiscovery({
        run: async (bin) =>
          bin === 'gh'
            ? { stdout: '', stderr: 'github.acme.internal\n  ✓ Logged in to github.acme.internal account someone (keyring)\n' }
            : { stdout: '', stderr: '', notFound: true },
      });
      expect(forgeKindOfHost('github.acme.internal')).toBe('github');
    });

    it('never warms from a test without an injected runner', async () => {
      __setForgeHostCacheFileForTests(join(dir, 'forge-hosts.json'));
      await refreshForgeDiscovery();
      expect(childProcess.execFile).not.toHaveBeenCalled();
      expect(fs.existsSync(join(dir, 'forge-hosts.json'))).toBe(false);
    });
  });
});

describe('GitHub driver viewUrl', () => {
  const driver = resolveForge(info('git@github.com:acme/demo.git'))!;

  it.each([
    ['repo', 'x', 'https://github.com/acme/demo'],
    ['issue', 142, 'https://github.com/acme/demo/issues/142'],
    ['pr', 128, 'https://github.com/acme/demo/pull/128'],
    ['branch', 'feat/cockpit ui', 'https://github.com/acme/demo/tree/feat/cockpit%20ui'],
    ['commit', 'abc1234', 'https://github.com/acme/demo/commit/abc1234'],
  ] as const)('%s → %s', (kind, ref, expected) => {
    expect(driver.viewUrl(kind, ref)).toBe(expected);
  });
});

describe('ForgeDriver optional capabilities', () => {
  // Type-level (spec 2026-08-10-forge-provider-adapters § Driver interface changes): a driver
  // implementing only the required members must compile — every capability beyond them
  // (search, merge, diff, comments, checks, ref status) is optional, and routes degrade in-payload.
  const minimal: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: false, reason: 'test' }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('allows omitting every optional method', () => {
    expect(minimal.searchItems).toBeUndefined();
    expect(minimal.prMergeState).toBeUndefined();
    expect(minimal.mergePR).toBeUndefined();
    expect(minimal.prDiff).toBeUndefined();
    expect(minimal.listComments).toBeUndefined();
    expect(minimal.listChecks).toBeUndefined();
    expect(minimal.refStatus).toBeUndefined();
    expect(minimal.listAll).toBeUndefined();
  });

  it('classifies a gitlab remote but still resolves no driver for it', () => {
    expect(forgeKindOfRemote('git@gitlab.com:acme/demo.git')).toBe('gitlab');
    expect(resolveForge(info('git@gitlab.com:acme/demo.git'))).toBeNull();
  });
});

describe('listForgeItems / searchForgeItems (the /github and /github/search routes)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.4: both routes go through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const item = (kind: 'issue' | 'pr', number: number): ForgeItem => ({
    kind,
    number,
    title: `#${number}`,
    author: 'someone',
    createdAt: '2026-01-01T00:00:00Z',
    labels: [],
    body: '',
    url: `https://forge.example/${number}`,
    comments: 0,
  });
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [item('issue', 1)],
    listPRs: async () => [item('pr', 2)],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payloads for a null forge', async () => {
    expect(await listForgeItems(null, {})).toEqual({ available: false, reason: NO_FORGE_REASON, issues: [], prs: [] });
    expect(await searchForgeItems(null, 'pr', '1', {})).toEqual({ available: false, reason: NO_FORGE_REASON, items: [] });
  });

  it('serves listAll verbatim and passes the options through', async () => {
    const seen: unknown[] = [];
    const payload = { available: true, repo: 'acme/demo', issues: [], prs: [], labelColors: { bug: 'd73a4a' } };
    const driver: ForgeDriver = { ...base, listAll: async (opts) => (seen.push(opts), payload) };
    expect(await listForgeItems(driver, { refresh: true, limit: 5 })).toBe(payload);
    expect(seen).toEqual([{ refresh: true, limit: 5 }]);
  });

  it('lists a driver without listAll through listIssues + listPRs', async () => {
    const data = await listForgeItems(base, { limit: 5 });
    expect(data).toMatchObject({ available: true, issues: [item('issue', 1)], prs: [item('pr', 2)] });
    expect(data.labelColors).toBeUndefined();
  });

  it('degrades a failing fallback listing instead of throwing', async () => {
    const driver: ForgeDriver = {
      ...base,
      listPRs: async () => {
        throw new Error('glab: 401 Unauthorized\nmore detail');
      },
    };
    expect(await listForgeItems(driver, {})).toEqual({
      available: false,
      reason: 'glab: 401 Unauthorized',
      issues: [],
      prs: [],
    });
  });

  it('degrades search for a driver without searchItems', async () => {
    expect(await searchForgeItems(base, 'issue', 'login', {})).toEqual({
      available: false,
      reason: 'Search is not supported for this gitlab remote',
      items: [],
    });
  });

  it('delegates search to searchItems with the limit', async () => {
    const calls: unknown[] = [];
    const driver: ForgeDriver = {
      ...base,
      searchItems: async (kind, query, opts) => (calls.push([kind, query, opts]), { available: true, items: [] }),
    };
    expect(await searchForgeItems(driver, 'pr', 'fix', { limit: 7 })).toEqual({ available: true, items: [] });
    expect(calls).toEqual([['pr', 'fix', { limit: 7 }]]);
  });
});

describe('listForgeComments (the /github/comments route)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.5: the route goes through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payload for a null forge', async () => {
    expect(await listForgeComments(null, 'issue', 1, {})).toEqual({
      available: false,
      reason: NO_FORGE_REASON,
      comments: [],
    });
  });

  it('degrades for a driver without listComments', async () => {
    expect(await listForgeComments(base, 'pr', 137, {})).toEqual({
      available: false,
      reason: 'Comments are not supported for this gitlab remote',
      comments: [],
    });
  });

  it('delegates to listComments with the kind, number and options', async () => {
    const calls: unknown[] = [];
    const payload = { available: true, comments: [] };
    const driver: ForgeDriver = {
      ...base,
      listComments: async (kind, number, opts) => (calls.push([kind, number, opts]), payload),
    };
    expect(await listForgeComments(driver, 'pr', 137, { refresh: true })).toBe(payload);
    expect(calls).toEqual([['pr', 137, { refresh: true }]]);
  });
});

describe('listForgeChecks (the /github/checks route)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.6: the route goes through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payload for a null forge', async () => {
    // ForgeChecksData's unavailable branch carries only `reason` — no `checks` field to empty.
    expect(await listForgeChecks(null, [1])).toEqual({
      available: false,
      reason: NO_FORGE_REASON,
    });
  });

  it('degrades for a driver without listChecks', async () => {
    expect(await listForgeChecks(base, [1])).toEqual({
      available: false,
      reason: 'CI checks are not supported for this gitlab remote',
    });
  });

  it('delegates to listChecks with the numbers', async () => {
    const calls: unknown[] = [];
    const payload: ForgeChecksData = { available: true, checks: { 1: 'passing' } };
    const driver: ForgeDriver = {
      ...base,
      listChecks: async (numbers) => (calls.push(numbers), payload),
    };
    expect(await listForgeChecks(driver, [1, 2])).toBe(payload);
    expect(calls).toEqual([[1, 2]]);
  });
});

describe('forgeRefStatus (the /github/ref-status route)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.7: the route goes through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payload for a null forge', async () => {
    // A forge that cannot answer at all has nothing to recheck.
    expect(await forgeRefStatus(null, [1], [2])).toEqual({
      available: false,
      reason: NO_FORGE_REASON,
      recheckAfterMs: null,
    });
  });

  it('degrades for a driver without refStatus', async () => {
    expect(await forgeRefStatus(base, [1], [])).toEqual({
      available: false,
      reason: 'Reference status is not supported for this gitlab remote',
      recheckAfterMs: null,
    });
  });

  it('delegates to refStatus with the prs and issues lists', async () => {
    const calls: unknown[] = [];
    const payload: ForgeRefStatusData = { available: true, prs: {}, issues: {}, recheckAfterMs: null };
    const driver: ForgeDriver = {
      ...base,
      refStatus: async (prs, issues) => (calls.push([prs, issues]), payload),
    };
    expect(await forgeRefStatus(driver, [1, 2], [3])).toBe(payload);
    expect(calls).toEqual([[[1, 2], [3]]]);
  });
});

describe('forgePrDiff (the /github/prs/:number/changes route)', () => {
  // Spec 2026-08-10-forge-provider-adapters, Step 1.8: the route goes through the driver, and a
  // missing forge or capability degrades in the payload instead of throwing.
  const base: ForgeDriver = {
    kind: 'gitlab',
    detect: async () => ({ available: true }),
    detectCached: () => null,
    listIssues: async () => [],
    listPRs: async () => [],
    createPR: async () => ({ ok: false, error: 'test' }),
    prStatus: async () => null,
    viewUrl: () => null,
  };

  it('answers the unavailable payload for a null forge', async () => {
    expect(await forgePrDiff(null, 1, {})).toEqual({ available: false, reason: NO_FORGE_REASON });
  });

  it('degrades for a driver without prDiff', async () => {
    expect(await forgePrDiff(base, 1, {})).toEqual({
      available: false,
      reason: 'Pull request changes are not supported for this gitlab remote',
    });
  });

  it('delegates to prDiff with the number and options', async () => {
    const calls: unknown[] = [];
    const payload: ForgePrDiffResult = {
      available: true,
      number: 1,
      headSha: 'a'.repeat(40),
      files: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    };
    const driver: ForgeDriver = {
      ...base,
      prDiff: async (number, opts) => (calls.push([number, opts]), payload),
    };
    expect(await forgePrDiff(driver, 1, { refresh: true })).toBe(payload);
    expect(calls).toEqual([[1, { refresh: true }]]);
  });

  it('lets a driver rejection propagate — the route needs it to map 404s', async () => {
    class NotFound extends Error {}
    const driver: ForgeDriver = {
      ...base,
      prDiff: async () => { throw new NotFound('nope'); },
    };
    await expect(forgePrDiff(driver, 1, {})).rejects.toBeInstanceOf(NotFound);
  });
});
