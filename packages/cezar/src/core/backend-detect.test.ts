import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same technique as `server/forge/gitlab.test.ts`: `detectEnvironment()` builds its runners from
// `promisify(execFile)` at module load, so every probe below is driven through this mock — no
// real `gh`/`glab`/agent CLI on the box, no network.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import { detectEnvironment } from './backend-detect.ts';

type Callback = (err: unknown, value?: unknown) => void;

/** ENOENT — as a real spawn reports a missing binary. */
function enoent(bin: string): NodeJS.ErrnoException {
  const err = new Error(`spawn ${bin} ENOENT`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

/** A non-zero exit (e.g. `glab auth status` when logged out) — promisify(execFile) rejects.
 *  Only the rejection matters to `probeGlab`'s bare `catch {}`, not the shape of the error. */
function exitCode(code: number): Error {
  return Object.assign(new Error(`Command failed with exit code ${code}`), { code });
}

/** Route every mocked `execFile` call by binary name; anything not in `byBin` reports ENOENT
 *  (a CLI that simply isn't installed), so a test only has to describe what it cares about. */
function mockExecFile(byBin: Record<string, { stdout?: string } | Error>) {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const bin = args[0] as string;
    const cb = args[args.length - 1] as Callback;
    const resp = byBin[bin];
    if (!resp) {
      cb(enoent(bin));
      return;
    }
    if (resp instanceof Error) {
      cb(resp);
      return;
    }
    cb(null, { stdout: resp.stdout ?? '', stderr: '' });
  });
}

describe('detectEnvironment — glab probe', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit probeClaude/probePi
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports glab available when `glab auth status` exits 0', async () => {
    mockExecFile({ glab: { stdout: 'gitlab.com\n  ✓ Logged in to gitlab.com as example-user (keyring)\n' } });
    const checks = await detectEnvironment();
    const glab = checks.find((c) => c.name === 'glab');
    expect(glab).toEqual({ name: 'glab', available: true, version: 'authenticated' });
  });

  it('reports glab unavailable with an optional-install hint when logged out', async () => {
    mockExecFile({ glab: exitCode(1) });
    const checks = await detectEnvironment();
    const glab = checks.find((c) => c.name === 'glab');
    expect(glab?.available).toBe(false);
    expect(glab?.hint).toBe(
      'optional: install the GitLab CLI and run `glab auth login` (only needed for GitLab projects)',
    );
  });

  it('reports glab unavailable with the same hint when the CLI is not installed (ENOENT)', async () => {
    mockExecFile({}); // every bin, including glab, is missing
    const checks = await detectEnvironment();
    const glab = checks.find((c) => c.name === 'glab');
    expect(glab?.available).toBe(false);
    expect(glab?.hint).toBe(
      'optional: install the GitLab CLI and run `glab auth login` (only needed for GitLab projects)',
    );
  });

  it('never fails detectEnvironment as a whole when glab is missing — gh and others still resolve', async () => {
    mockExecFile({ gh: { stdout: 'gho_sometoken\n' } });
    const checks = await detectEnvironment();
    expect(checks.find((c) => c.name === 'gh')).toMatchObject({ name: 'gh', available: true });
    expect(checks.find((c) => c.name === 'glab')).toMatchObject({ name: 'glab', available: false });
  });
});
