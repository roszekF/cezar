import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Host-side git hardening for sandboxed worktrees (spec 2026-09-22-docker-sandboxes,
 * § Host-git hardening).
 *
 * A sandboxed run's worktree is writable from inside the VM, and so is its `.git`
 * gitlink file. The host still runs git there (autosave, diff, commit, push, `gh pr
 * create`), and plain `git -C <worktree>` follows the gitlink wherever the agent points
 * it — to a git dir whose config can name an fsmonitor, a hook path or a credential
 * helper that the HOST then executes. The Phase 0 spike reproduced exactly that.
 *
 * So for a registered worktree every host git invocation gets:
 *  - `GIT_DIR` / `GIT_COMMON_DIR` / `GIT_WORK_TREE` pinned to paths verified on the host
 *    at registration time, before any VM can touch them — the gitlink is never read
 *    again;
 *  - `core.hooksPath=/dev/null` and `core.fsmonitor=false`, passed as `GIT_CONFIG_*`
 *    env rather than `-c` flags so they also reach the git that `gh` runs internally.
 *
 * Pinning is not a full override: git's ref store still reads the admin dir's
 * `commondir` file even when `GIT_COMMON_DIR` is set. So the admin dir's `commondir`
 * and `gitdir` are snapshotted at registration and re-checked on every call; if either
 * changed, git gets a `GIT_DIR` that does not exist and refuses to run (fail closed).
 * In a real sandbox both files are read-only (`:ro` hold-outs, spike check g), so this
 * only fires if that layer is ever bypassed.
 *
 * Worktrees that were never registered get no change at all — `withSandboxGitEnv`
 * returns the caller's env untouched.
 */

interface PinnedGitDirs {
  worktree: string;
  gitDir: string;
  commonDir: string;
  /** `commondir` / `gitdir` contents at registration, re-checked before every call. */
  commondirFile: string;
  gitdirFile: string;
}

const registry = new Map<string, PinnedGitDirs>();

const HARDENED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
];

/**
 * Find the worktree's admin dir under `<repoRoot>/.git/worktrees/` by its back-pointer
 * (`gitdir` → `<worktree>/.git`), not by name: git suffixes the admin dir when a stale
 * one exists. Must run before the worktree is exposed to a VM. Returns false when the
 * repo has no `.git` directory or no admin dir points back at this worktree.
 */
export async function registerSandboxedWorktree(repoRoot: string, worktreePath: string): Promise<boolean> {
  const worktree = resolve(worktreePath);
  const commonDir = join(resolve(repoRoot), '.git');
  try {
    if (!(await stat(commonDir)).isDirectory()) return false;
    const adminRoot = join(commonDir, 'worktrees');
    for (const name of await readdir(adminRoot)) {
      const gitDir = join(adminRoot, name);
      const pointer = await readFile(join(gitDir, 'gitdir'), 'utf8').catch(() => '');
      if (resolve(pointer.trim()) === join(worktree, '.git')) {
        const commondirFile = await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '');
        registry.set(worktree, { worktree, gitDir, commonDir, commondirFile, gitdirFile: pointer });
        return true;
      }
    }
  } catch {
    // no .git dir / no worktrees dir — nothing to pin
  }
  return false;
}

export function unregisterSandboxedWorktree(worktreePath: string): void {
  registry.delete(resolve(worktreePath));
}

function pinnedFor(cwd: string): PinnedGitDirs | undefined {
  const dir = resolve(cwd);
  for (const pinned of registry.values()) {
    const rel = relative(pinned.worktree, dir);
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return pinned;
  }
  return undefined;
}

function untampered(pinned: PinnedGitDirs): boolean {
  const read = (name: string): string | null => {
    try {
      return readFileSync(join(pinned.gitDir, name), 'utf8');
    } catch {
      return null;
    }
  };
  return read('commondir') === pinned.commondirFile && read('gitdir') === pinned.gitdirFile;
}

/** The hardening env for `cwd`, or undefined when it is not inside a registered worktree. */
export function sandboxGitEnv(cwd: string): Record<string, string> | undefined {
  const pinned = pinnedFor(cwd);
  if (!pinned) return undefined;
  const env: Record<string, string> = {
    GIT_DIR: untampered(pinned) ? pinned.gitDir : join(pinned.gitDir, 'cez-refused-tampered-admin-dir'),
    GIT_COMMON_DIR: pinned.commonDir,
    GIT_WORK_TREE: pinned.worktree,
    GIT_CONFIG_COUNT: String(HARDENED_CONFIG.length),
  };
  HARDENED_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * The env a host git (or `gh`) call in `cwd` should run with. Unregistered → `env`
 * exactly as given (undefined keeps "inherit process.env"). Registered → the process env,
 * the caller's overrides, then the hardening on top so a caller can never undo it.
 */
export function withSandboxGitEnv<T extends NodeJS.ProcessEnv | undefined>(
  cwd: string,
  env: T,
): T | NodeJS.ProcessEnv {
  const hardened = sandboxGitEnv(cwd);
  if (!hardened) return env;
  return { ...process.env, ...env, ...hardened };
}

/** The host-verified admin dir of a registered worktree — what a sandbox holds `:ro`. */
export function pinnedAdminDir(worktreePath: string): string | undefined {
  return registry.get(resolve(worktreePath))?.gitDir;
}
