import { describe, expect, it } from 'vitest';
import type { RepoInfo } from '../git.ts';
import {
  forgeKindOfRemote,
  listForgeComments,
  listForgeItems,
  NO_FORGE_REASON,
  parseRemote,
  resolveForge,
  searchForgeItems,
} from './index.ts';
import type { ForgeDriver, ForgeItem } from './types.ts';

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
    ['git@gitlab.com:acme/demo.git', null],
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

  it('returns null for an unknown forge host (GitLab lands here later)', () => {
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

  it('still resolves no driver for a gitlab remote', () => {
    expect(forgeKindOfRemote('git@gitlab.com:acme/demo.git')).toBeNull();
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
