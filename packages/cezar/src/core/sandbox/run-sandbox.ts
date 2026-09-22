import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { sandboxRunDir } from '../../handoff.ts';
import type { AgentRunSpec } from '../agent-runner.ts';
import {
  ensureSandbox,
  isCezarSandboxName,
  listSandboxes,
  removeSandbox,
  sandboxLauncher,
  stopSandbox,
  type SandboxAgent,
} from './docker-sbx.ts';
import { pinnedAdminDir, registerSandboxedWorktree, unregisterSandboxedWorktree } from './sandbox-git.ts';

/**
 * A run's Docker Sandbox, from the engine's side (spec 2026-09-22-docker-sandboxes).
 *
 * The run RECORD is the source of truth (`record.sandbox`), exactly as it is for `autonomous`:
 * every spawn re-reads it, so the choice survives a restart, a queued revive, a Continue and an
 * auto-resume without being threaded through each of them.
 *
 * The VM sees, each at its host path:
 *  - the task worktree (primary, read-write);
 *  - the repo's `.git` (read-write: the agent commits), with `config`, `hooks/`, `info/` and
 *    this worktree's `commondir` / `gitdir` held read-only — the files that would make HOST git
 *    run something (spike check g, and `sandbox-git.ts` as the second layer);
 *  - `.ai/cezar/sandbox/<runId>/` — the handoff journal and the run's temp directory;
 *  - the run's pasted images, read-only.
 * Never the main checkout, never the rest of `.ai/cezar/` (runs.json, workflows, other runs).
 */

export interface SandboxedRecord {
  id: string;
  sandbox?: { name: string; createdAt?: string; removedAt?: string };
  worktreePath?: string;
  status?: string;
}

/** Env names that cross into the VM. Everything else — provider keys, `GH_*`, `SSH_AUTH_SOCK`,
 *  `CLAUDE_CONFIG_DIR`, `HOME`, `PATH` — stays on the host (spec Q5; sbx's own guidance). */
const RUN_ENV = ['CEZ_HANDOFF_FILE', 'CEZ_TASK_ID', 'CEZ_TODOS_FILE', 'TMPDIR', 'TEMP', 'TMP', 'CLAUDE_CODE_TMPDIR'];

export function sandboxForwardKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const passthrough = (env.CEZ_ENV_PASSTHROUGH ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return [...RUN_ENV, ...passthrough];
}

/** The run's temp directory inside the VM. Mount parents are root-owned there, so Claude needs
 *  `CLAUDE_CODE_TMPDIR` pointed at a directory the VM user owns (spike finding). */
export function sandboxTmpEnv(dataDir: string, runId: string): Record<string, string> {
  const tmp = join(sandboxRunDir(dataDir, runId), 'tmp');
  mkdirSync(tmp, { recursive: true });
  return { TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDE_CODE_TMPDIR: tmp };
}

export interface PrepareInput {
  repoRoot: string;
  dataDir: string;
  record: SandboxedRecord;
  backend: string;
  memoryMb?: number;
}

/**
 * Register the worktree for host-git hardening, then make sure the VM exists. Throws with a
 * message fit for the run log. `created: true` = a fresh VM, so any earlier session is gone.
 */
export async function prepareRunSandbox(input: PrepareInput): Promise<{ created: boolean }> {
  const { repoRoot, dataDir, record, backend } = input;
  if (!record.sandbox) throw new Error('internal: prepareRunSandbox on a run without a sandbox');
  if (backend !== 'claude' && backend !== 'codex') {
    throw new Error(`a sandboxed run supports Claude and Codex only — this step uses ${backend}`);
  }
  const worktree = record.worktreePath;
  if (!worktree) throw new Error('a sandboxed run needs its worktree, and this run has none');
  // Host-side verification happens BEFORE the VM can touch anything (sandbox-git.ts).
  if (!(await registerSandboxedWorktree(repoRoot, worktree))) {
    throw new Error(`could not verify the git worktree at ${worktree} — refusing to sandbox it`);
  }
  const adminDir = pinnedAdminDir(worktree);
  const gitDir = join(resolve(repoRoot), '.git');
  // A hold-out must exist to be held: an absent `hooks/` would otherwise be creatable in the VM.
  for (const dir of ['hooks', 'info']) mkdirSync(join(gitDir, dir), { recursive: true });
  const runDir = sandboxRunDir(dataDir, record.id);
  mkdirSync(runDir, { recursive: true });
  const images = join(dataDir, 'runs', `${record.id}-images`);
  mkdirSync(images, { recursive: true });

  const workspaces = [
    worktree,
    gitDir,
    `${join(gitDir, 'config')}:ro`,
    `${join(gitDir, 'hooks')}:ro`,
    `${join(gitDir, 'info')}:ro`,
    ...(adminDir ? [`${join(adminDir, 'commondir')}:ro`, `${join(adminDir, 'gitdir')}:ro`] : []),
    runDir,
    `${images}:ro`,
  ];
  const result = await ensureSandbox({
    name: record.sandbox.name,
    agent: backend as SandboxAgent,
    workspaces,
    memoryMb: input.memoryMb,
  });
  if ('error' in result) throw new Error(result.error);
  return result;
}

/**
 * The agent spec a sandboxed step spawns with: the VM launcher, the run's own env only, and
 * `--add-dir` limited to what the VM can see. A fresh VM has no copy of the old session, so a
 * resume becomes a new session told to pick up from the handoff journal.
 */
export function sandboxAgentSpec(
  spec: AgentRunSpec,
  opts: { name: string; dataDir: string; runId: string; backend: SandboxAgent; created: boolean },
): { spec: AgentRunSpec; restartedSession: boolean } {
  const runDir = sandboxRunDir(opts.dataDir, opts.runId);
  const env = { ...spec.env, ...sandboxTmpEnv(opts.dataDir, opts.runId), CEZ_TODOS_FILE: '' };
  // The runner resolved a HOST path for its CLI (`CEZ_CLAUDE_BIN`…); the VM has its own agent on
  // PATH. Dry-run keeps the mock path so the fake sbx (which runs locally) can drive the mock.
  const bin = process.env.CEZ_DRY_RUN === '1' ? undefined : opts.backend;
  const restartedSession = opts.created && spec.resume === true;
  return {
    restartedSession,
    spec: {
      ...spec,
      env,
      launcher: sandboxLauncher(opts.name, sandboxForwardKeys(), { bin }),
      additionalDirectories: [runDir],
      ...(restartedSession ? { resume: false } : {}),
    },
  };
}

/** Removal for good (run deleted, variant lost, worktree reclaimed). Best-effort. */
export async function disposeRunSandbox(record: SandboxedRecord): Promise<boolean> {
  if (!record.sandbox || record.sandbox.removedAt) return false;
  if (record.worktreePath) unregisterSandboxedWorktree(record.worktreePath);
  return removeSandbox(record.sandbox.name);
}

/** Stop at a terminal transition, keeping state for a later Continue. Best-effort. */
export function stopRunSandbox(record: SandboxedRecord | undefined): void {
  if (!record?.sandbox || record.sandbox.removedAt) return;
  void stopSandbox(record.sandbox.name);
}

/**
 * Boot reconcile. Re-registers every sandboxed worktree for host-git hardening (the registry
 * is in memory, and the cockpit's diff routes run git on these worktrees before any spawn), then
 * — only when this repo has sandboxed runs at all, so a user who never flipped the toggle never
 * wakes the sbx daemon — removes cezar's VMs for this repo whose run no longer exists and stops
 * every one still running. At boot nothing is live in this process yet, so a running VM is a
 * crash leftover whose inner agent may still be writing (killing the exec client does not stop
 * it: spike check c); `recover()` then resumes what should resume, restarting the VM on demand.
 * Assumes one cezar process per repo, like the repo-root lease.
 * Scoped by name AND primary workspace, so another project's `cez-*` VMs are never touched.
 */
export async function reconcileSandboxes(
  repoRoot: string,
  records: SandboxedRecord[],
): Promise<{ removed: string[]; stopped: string[] }> {
  const sandboxed = records.filter((r) => r.sandbox);
  for (const run of sandboxed) {
    if (run.worktreePath && !run.sandbox?.removedAt) await registerSandboxedWorktree(repoRoot, run.worktreePath);
  }
  const outcome = { removed: [] as string[], stopped: [] as string[] };
  if (!sandboxed.length) return outcome;
  const boxes = await listSandboxes();
  if (!boxes) return outcome;
  const worktreesRoot = join(resolve(repoRoot), '.ai/cezar/worktrees') + sep;
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const box of boxes) {
    const runId = isCezarSandboxName(box.name);
    if (!runId || !(box.workspaces[0] ?? '').startsWith(worktreesRoot)) continue;
    const run = byId.get(runId);
    if (!run) {
      if (await removeSandbox(box.name)) outcome.removed.push(box.name);
    } else if (box.status === 'running') {
      if (await stopSandbox(box.name)) outcome.stopped.push(box.name);
    }
  }
  return outcome;
}

/**
 * A sandbox has its OWN logins (spec Q5), so an agent that is signed in on the host can be signed
 * out in its VM. Recognize the backends' "not signed in" errors and say how to fix it once, for
 * every future sandbox. Undefined when the message is anything else.
 */
export function sandboxAuthHint(message: string): string | undefined {
  if (/not logged in|please run \/login|oauth token (has )?expired/i.test(message)) {
    return 'this task runs in a Docker Sandbox, which has its own Claude login — log in once for all sandboxes: run `sbx run claude` in any folder, type /login, then exit';
  }
  if (/(openai|codex|chatgpt)/i.test(message) && /(401|unauthori[sz]ed|not (logged|signed) in|login)/i.test(message)) {
    return 'this task runs in a Docker Sandbox, which has its own Codex login — sign in once for all sandboxes: `sbx secret set openai --oauth`';
  }
  if (/not authenticated to docker|sbx login/i.test(message)) {
    return 'Docker Sandboxes is signed out — run `sbx login`, then Continue';
  }
  return undefined;
}
