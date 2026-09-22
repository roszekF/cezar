import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { autosaveCommit } from '../../git-worktree.js';
import {
  registerSandboxedWorktree,
  sandboxGitEnv,
  unregisterSandboxedWorktree,
  withSandboxGitEnv,
} from './sandbox-git.js';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

function sh(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env: env ?? process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repo with one cezar-shaped worktree at `.ai/cezar/worktrees/<id>` on `cez/<id>`. */
function repoWithWorktree(id = 'run-1'): { repo: string; wt: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cez-sbxgit-')));
  sh(repo, ['init', '-q']);
  sh(repo, [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init']);
  const wt = join(repo, '.ai/cezar/worktrees', id);
  sh(repo, ['worktree', 'add', '-q', '-b', `cez/${id}`, wt]);
  return { repo, wt };
}

/** A script that records it was run, for hook and fsmonitor planting. */
function markerScript(path: string, marker: string): void {
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(path, 0o755);
}

describe('registerSandboxedWorktree', () => {
  it('pins the admin dir found by back-pointer, not by name', async () => {
    const { repo, wt } = repoWithWorktree('same');
    // A second worktree with the same basename makes git suffix its admin dir.
    const other = join(repo, 'elsewhere/same');
    mkdirSync(join(repo, 'elsewhere'));
    sh(repo, ['worktree', 'add', '-q', '-b', 'other', other]);
    expect(await registerSandboxedWorktree(repo, other)).toBe(true);
    const env = sandboxGitEnv(other);
    expect(env?.GIT_DIR).not.toBe(join(repo, '.git/worktrees/same'));
    expect(readFileSync(join(env?.GIT_DIR ?? '', 'gitdir'), 'utf8').trim()).toBe(join(other, '.git'));
    expect(env?.GIT_WORK_TREE).toBe(other);
    expect(env?.GIT_COMMON_DIR).toBe(join(repo, '.git'));
    unregisterSandboxedWorktree(other);
    void wt;
  });

  it('refuses a directory no admin dir points back at', async () => {
    const { repo } = repoWithWorktree();
    const stray = join(repo, '.ai/cezar/worktrees/not-a-worktree');
    mkdirSync(stray);
    expect(await registerSandboxedWorktree(repo, stray)).toBe(false);
    expect(sandboxGitEnv(stray)).toBeUndefined();
  });
});

describe('withSandboxGitEnv', () => {
  it('leaves an unregistered worktree exactly as the caller asked', () => {
    const { wt } = repoWithWorktree();
    expect(withSandboxGitEnv(wt, undefined)).toBeUndefined();
    const env = { FOO: '1' };
    expect(withSandboxGitEnv(wt, env)).toBe(env);
  });

  it('covers subdirectories but not a sibling that shares the prefix', async () => {
    const { repo, wt } = repoWithWorktree('run-2');
    mkdirSync(join(wt, 'sub'));
    await registerSandboxedWorktree(repo, wt);
    expect(sandboxGitEnv(join(wt, 'sub'))).toBeDefined();
    expect(sandboxGitEnv(`${wt}-other`)).toBeUndefined();
    unregisterSandboxedWorktree(wt);
    expect(sandboxGitEnv(wt)).toBeUndefined();
  });

  it('keeps the caller overrides but never lets them undo the hardening', async () => {
    const { repo, wt } = repoWithWorktree();
    await registerSandboxedWorktree(repo, wt);
    const env = withSandboxGitEnv(wt, { GIT_INDEX_FILE: '/x', GIT_DIR: '/evil' });
    expect(env?.GIT_INDEX_FILE).toBe('/x');
    expect(env?.GIT_DIR).toBe(sandboxGitEnv(wt)?.GIT_DIR);
    unregisterSandboxedWorktree(wt);
  });
});

describe('host git on a sandboxed worktree the VM has tampered with', () => {
  it('ignores a rewritten gitlink (the spike attack)', async () => {
    const { repo, wt } = repoWithWorktree();
    await registerSandboxedWorktree(repo, wt);
    writeFileSync(join(wt, '.git'), 'gitdir: /evil\n');

    expect(() => sh(wt, ['status'])).toThrow(); // plain git follows the redirect
    expect(sh(wt, ['rev-parse', '--abbrev-ref', 'HEAD'], withSandboxGitEnv(wt, process.env))).toBe('cez/run-1\n');
    unregisterSandboxedWorktree(wt);
  });

  it('fails closed when the admin dir pointers were rewritten, running nothing', async () => {
    const { repo, wt } = repoWithWorktree();
    await registerSandboxedWorktree(repo, wt);
    const adminDir = sandboxGitEnv(wt)?.GIT_DIR ?? '';
    // An attacker common dir whose config would run an fsmonitor on the host.
    const evil = join(repo, 'evil.git');
    sh(repo, ['init', '-q', '--bare', evil]);
    const marker = join(repo, 'evil-ran');
    markerScript(join(repo, 'evil.sh'), marker);
    sh(evil, ['config', 'core.fsmonitor', join(repo, 'evil.sh')]);
    writeFileSync(join(adminDir, 'commondir'), `${evil}\n`);

    expect(sandboxGitEnv(wt)?.GIT_DIR).not.toBe(adminDir);
    expect(() => sh(wt, ['status', '--porcelain'], withSandboxGitEnv(wt, process.env))).toThrow(/not a git repository/);
    expect(existsSync(marker)).toBe(false);
    unregisterSandboxedWorktree(wt);
  });

  it('runs no hook from core.hooksPath, including one pointed into the worktree', async () => {
    const { repo, wt } = repoWithWorktree();
    await registerSandboxedWorktree(repo, wt);
    mkdirSync(join(wt, '.husky'));
    const marker = join(repo, 'hook-ran');
    markerScript(join(wt, '.husky/pre-commit'), marker);
    sh(repo, ['config', 'core.hooksPath', '.husky']);
    writeFileSync(join(wt, 'a.txt'), 'a');

    sh(wt, ['add', 'a.txt'], withSandboxGitEnv(wt, process.env));
    sh(wt, [...IDENTITY, 'commit', '-q', '-m', 'hardened'], withSandboxGitEnv(wt, process.env));
    expect(existsSync(marker)).toBe(false);

    // Control: the same commit without hardening does run it, so the assertion above means something.
    writeFileSync(join(wt, 'b.txt'), 'b');
    sh(wt, ['add', 'b.txt']);
    sh(wt, [...IDENTITY, 'commit', '-q', '-m', 'plain']);
    expect(existsSync(marker)).toBe(true);
    unregisterSandboxedWorktree(wt);
  });

  it('runs no core.fsmonitor command', async () => {
    const { repo, wt } = repoWithWorktree();
    await registerSandboxedWorktree(repo, wt);
    const marker = join(repo, 'fsmonitor-ran');
    markerScript(join(repo, 'monitor.sh'), marker);
    sh(repo, ['config', 'core.fsmonitor', join(repo, 'monitor.sh')]);

    sh(wt, ['status', '--porcelain'], withSandboxGitEnv(wt, process.env));
    expect(existsSync(marker)).toBe(false);

    sh(wt, ['status', '--porcelain']);
    expect(existsSync(marker)).toBe(true);
    unregisterSandboxedWorktree(wt);
  });

  it('autosave (a real wrapper) commits through a redirected gitlink', async () => {
    const { repo, wt } = repoWithWorktree();
    await registerSandboxedWorktree(repo, wt);
    writeFileSync(join(wt, '.git'), 'gitdir: /evil\n');
    writeFileSync(join(wt, 'work.txt'), 'agent output');

    const result = await autosaveCommit(wt, 'turn end');
    expect(result).toBe('committed');
    expect(sh(repo, ['log', '-1', '--format=%s', 'cez/run-1'])).toMatch(/autosave|cez/i);
    expect(sh(repo, ['show', '--name-only', '--format=', 'cez/run-1']).trim()).toBe('work.txt');
    unregisterSandboxedWorktree(wt);
  });
});

/**
 * Every source file that spawns git. A new one fails this test until it is classified:
 * either it routes through `withSandboxGitEnv` (it can run in a run's worktree) or it is
 * listed as repo-root / unrelated-dir only. An unhardened git call on a sandboxed
 * worktree silently reopens the gitlink escape, so this list is the guard.
 */
describe('git spawn sites', () => {
  const HARDENED = ['agent-config/seed.ts', 'git-worktree.ts', 'server/forge/github.ts', 'server/git-changes.ts', 'skills-remote.ts'];
  const ROOT_OR_UNRELATED = ['core/backend-detect.ts', 'core/sandbox/run-policy.ts', 'server/checkout.ts', 'server/git.ts'];

  it('are all classified, and the worktree-capable ones are hardened', () => {
    const src = fileURLToPath(new URL('../..', import.meta.url));
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__fixtures__' && name !== 'node_modules') walk(path);
        } else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
          const text = readFileSync(path, 'utf8');
          if (/\b(execFile|execFileSync|execFileAsync|spawn|spawnSync|exec)\(\s*['"]git['"]/.test(text) || /execTool\([^)]*['"]git['"]/.test(text)) {
            found.push(relative(src, path).split('\\').join('/'));
          }
        }
      }
    };
    walk(src);
    expect(found.sort()).toEqual([...HARDENED, ...ROOT_OR_UNRELATED].sort());
    for (const file of HARDENED) {
      expect(readFileSync(join(src, file), 'utf8'), file).toContain('withSandboxGitEnv(');
    }
  });
});
