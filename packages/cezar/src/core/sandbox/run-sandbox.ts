import { execFile } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runImagesDir, sandboxRunDir } from '../../handoff.ts';
import type { AgentRunSpec } from '../agent-runner.ts';
import {
  ensureSandbox,
  isCezarSandboxName,
  listSandboxes,
  removeSandbox,
  resolveSbxExecutable,
  sandboxLauncher,
  stopSandbox,
  type SandboxAgent,
} from './docker-sbx.ts';

/**
 * A run's Docker Sandbox, from the engine's side (spec 2026-09-22-docker-sandboxes).
 *
 * The run RECORD is the source of truth (`record.sandbox`), exactly as it is for `autonomous`:
 * every spawn re-reads it, so the choice survives a restart, a queued revive, a Continue and an
 * auto-resume without being threaded through each of them.
 *
 * Isolation comes from `sbx create --clone`: the agent works on a private in-container clone of
 * the repository and the host repo is mounted READ-ONLY. The VM therefore writes nothing at all
 * on the host — there is no host `.git` bind mount, so no gitlink, no `commondir`, no
 * `.git/modules` and no hook path it could redirect to make host git execute something. That
 * whole class is gone by construction rather than held off by read-only hold-outs.
 *
 * The VM sees, each at its host path:
 *  - the repository, read-only, as the clone's source (`/run/sandbox/source`);
 *  - its own clone of that repository, writable, at the repo root path — where the agent works;
 *  - `<cezarHome>/sandbox/<runId>/` — the handoff journal, the run's temp dir and its images.
 * Nothing under the repository is mounted: an extra workspace at a path inside the cloned repo
 * replaces the clone overlay there, leaving the VM with the mount and no working tree.
 *
 * Work comes back the other way: sbx publishes the VM's git over a loopback daemon and registers
 * it on the host as the `sandbox-<name>` remote, so `syncBackFromSandbox` fetches the agent's
 * commits and fast-forwards the task worktree's branch. The host's own git never runs inside the
 * VM and the VM's git never runs on the host.
 */

export interface SandboxedRecord {
  id: string;
  sandbox?: { name: string; agent?: 'claude' | 'codex'; createdAt?: string; removedAt?: string };
  worktreePath?: string;
  /** The task branch. The VM checks it out in its clone; the host fast-forwards it on sync-back. */
  branch?: string;
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
export function sandboxTmpEnv(runId: string): Record<string, string> {
  const tmp = join(sandboxRunDir(runId), 'tmp');
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

/** `git` on the host, never inside a sandboxed worktree. Resolves rather than rejects. */
function hostGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs }, (err, stdout, stderr) =>
      done({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    );
  });
}

/** The loopback remote `sbx create --clone` registers on the host for this sandbox. */
export function sandboxRemoteName(sandboxName: string): string {
  return `sandbox-${sandboxName}`;
}

/**
 * `--clone` refuses to run from a linked worktree, so cezar must create the sandbox from the
 * repository's MAIN checkout. A cezar booted inside someone's worktree therefore cannot sandbox.
 */
function isLinkedWorktree(repoRoot: string): boolean {
  try {
    return statSync(join(resolve(repoRoot), '.git')).isFile();
  } catch {
    return false;
  }
}

/**
 * Make sure the VM exists, with the task branch checked out in its clone. Throws with a message
 * fit for the run log. `created: true` = a fresh VM, so any earlier session is gone.
 */
export async function prepareRunSandbox(input: PrepareInput): Promise<{ created: boolean }> {
  const { repoRoot, record, backend } = input;
  if (!record.sandbox) throw new Error('internal: prepareRunSandbox on a run without a sandbox');
  if (backend !== 'claude' && backend !== 'codex') {
    throw new Error(`a sandboxed run supports Claude and Codex only — this step uses ${backend}`);
  }
  // One agent kit per sandbox: the VM has `claude` OR `codex` installed, not both. Without this
  // a Continue on the other backend fails as a bare "command not found" inside the VM.
  if (record.sandbox.agent && record.sandbox.agent !== backend) {
    throw new Error(
      `this run's sandbox was created for ${record.sandbox.agent} — continue it on ${record.sandbox.agent}, or remove the run's worktree to start a fresh sandbox on ${backend}`,
    );
  }
  if (!record.worktreePath) throw new Error('a sandboxed run needs its worktree, and this run has none');
  const root = resolve(repoRoot);
  if (isLinkedWorktree(root)) {
    throw new Error(
      'sandboxed runs need cezar to be running in the repository\'s main checkout — `sbx --clone` cannot clone from a linked worktree',
    );
  }
  // Everything the VM may write lives OUTSIDE the repository: a workspace mounted at a path
  // inside the cloned repo replaces the clone overlay there (Phase 1 spike), and the agent would
  // find the mount instead of a working tree.
  const runDir = sandboxRunDir(record.id);
  // `runImagesDir` relocates on the run directory's EXISTENCE, so create it first — otherwise the
  // first call resolves the in-repo path and every later one the relocated one, and the mount
  // lists disagree, which now (rightly) forces a recreate on every step.
  mkdirSync(runDir, { recursive: true });
  const images = runImagesDir(input.dataDir, record.id);
  mkdirSync(images, { recursive: true });

  const result = await ensureSandbox({
    name: record.sandbox.name,
    agent: backend as SandboxAgent,
    workspaces: [root, runDir, `${images}:ro`],
    memoryMb: input.memoryMb,
  });
  if ('error' in result) throw new Error(result.error);
  if (result.created) await initSandboxClone(record, root);
  return result;
}

/**
 * Point a fresh clone at the task branch and give it an identity. The clone is taken at create
 * time, so the branch already exists on the host as `origin/<branch>`; `-B` makes the checkout
 * idempotent. The identity is set because the VM has no global git config of its own and a
 * commit without one fails — the host's `user.*` is not inherited through a clone.
 */
async function initSandboxClone(record: SandboxedRecord, repoRoot: string): Promise<void> {
  const name = record.sandbox?.name;
  if (!name || !record.branch) return;
  const run = (args: string[]) =>
    new Promise<void>((done) => {
      execFile(
        resolveSbxExecutable(),
        ['exec', '-i', '-w', repoRoot, name, 'git', ...args],
        { encoding: 'utf8', timeout: 60_000 },
        () => done(),
      );
    });
  await run(['config', 'user.name', 'cezar']);
  await run(['config', 'user.email', 'cezar@localhost']);
  await run(['checkout', '-B', record.branch, `origin/${record.branch}`]);
}

/**
 * Bring the agent's commits back to the host: fetch the sandbox's loopback remote, then
 * fast-forward the task worktree's branch onto what the VM produced.
 *
 * This replaces host-side autosave for a sandboxed run. The host cannot see the VM's working
 * tree at all, so anything the agent has not committed is invisible here — `commitInSandbox`
 * is what turns it into something this can fetch. Best-effort throughout: a sync that fails is
 * a missed recovery point, never a reason to fail the run.
 */
export async function syncBackFromSandbox(repoRoot: string, record: SandboxedRecord): Promise<boolean> {
  if (!record.sandbox || record.sandbox.removedAt || !record.branch || !record.worktreePath) return false;
  const remote = sandboxRemoteName(record.sandbox.name);
  const fetched = await hostGit(resolve(repoRoot), ['fetch', '--no-tags', remote, record.branch]);
  if (!fetched.ok) return false;
  const merged = await hostGit(record.worktreePath, ['merge', '--ff-only', 'FETCH_HEAD']);
  return merged.ok;
}

/**
 * Commit whatever the agent left uncommitted, inside the VM, so `syncBackFromSandbox` has
 * something to fetch. The host equivalent (`autosaveCommit`) cannot reach the VM's working tree.
 */
export async function commitInSandbox(record: SandboxedRecord, repoRoot: string, message: string): Promise<boolean> {
  const name = record.sandbox?.name;
  if (!name || record.sandbox?.removedAt) return false;
  return new Promise((done) => {
    execFile(
      resolveSbxExecutable(),
      ['exec', '-i', '-w', resolve(repoRoot), name, 'sh', '-lc', `git add -A && git diff --cached --quiet || git commit -m ${JSON.stringify(message)}`],
      { encoding: 'utf8', timeout: 120_000 },
      (err) => done(!err),
    );
  });
}

/**
 * The agent spec a sandboxed step spawns with: the VM launcher, the run's own env only, and
 * `--add-dir` limited to what the VM can see. A fresh VM has no copy of the old session, so a
 * resume becomes a new session told to pick up from the handoff journal.
 */
export function sandboxAgentSpec(
  spec: AgentRunSpec,
  opts: { name: string; repoRoot: string; runId: string; backend: SandboxAgent; created: boolean },
): { spec: AgentRunSpec; restartedSession: boolean } {
  const runDir = sandboxRunDir(opts.runId);
  const env = { ...spec.env, ...sandboxTmpEnv(opts.runId), CEZ_TODOS_FILE: '' };
  // The runner resolved a HOST path for its CLI (`CEZ_CLAUDE_BIN`…); the VM has its own agent on
  // PATH. Dry-run keeps the mock path so the fake sbx (which runs locally) can drive the mock.
  const bin = process.env.CEZ_DRY_RUN === '1' ? undefined : opts.backend;
  const restartedSession = opts.created && spec.resume === true;
  return {
    restartedSession,
    spec: {
      ...spec,
      env,
      // The agent works in the VM's own clone, which sits at the REPO ROOT path — the task
      // worktree the step names is a host-only artifact and is not mounted in the VM.
      launcher: sandboxLauncher(opts.name, sandboxForwardKeys(), { bin, cwd: resolve(opts.repoRoot) }),
      additionalDirectories: [runDir],
      ...(restartedSession ? { resume: false } : {}),
    },
  };
}

/**
 * Removal for good (run deleted, variant lost, worktree reclaimed). Best-effort. Also drops the
 * `sandbox-<name>` remote `sbx create --clone` wrote into the user's `.git/config`: cezar put it
 * there, so cezar takes it away rather than leaving one dead remote per task behind.
 */
export async function disposeRunSandbox(record: SandboxedRecord, repoRoot?: string): Promise<boolean> {
  if (!record.sandbox || record.sandbox.removedAt) return false;
  if (repoRoot) await hostGit(resolve(repoRoot), ['remote', 'remove', sandboxRemoteName(record.sandbox.name)]);
  return removeSandbox(record.sandbox.name);
}

/** Stop at a terminal transition, keeping state for a later Continue. Best-effort. */
export function stopRunSandbox(record: SandboxedRecord | undefined): void {
  if (!record?.sandbox || record.sandbox.removedAt) return;
  void stopSandbox(record.sandbox.name);
}

/**
 * Boot reconcile. Only when this repo has sandboxed runs at all — so a user who never flipped the
 * toggle never wakes the sbx daemon — removes cezar's VMs for this repo whose run no longer
 * exists and stops every one still running. At boot nothing is live in this process yet, so a
 * running VM is a crash leftover whose inner agent may still be writing (killing the exec client
 * does not stop it: spike check c); `recover()` then resumes what should resume, restarting the
 * VM on demand. Assumes one cezar process per repo, like the repo-root lease.
 *
 * Scoped by name AND primary workspace — which under `--clone` is the repo root itself — so
 * another project's `cez-*` VMs are never touched.
 */
export async function reconcileSandboxes(
  repoRoot: string,
  records: SandboxedRecord[],
): Promise<{ removed: string[]; stopped: string[] }> {
  const sandboxed = records.filter((r) => r.sandbox);
  const outcome = { removed: [] as string[], stopped: [] as string[] };
  if (!sandboxed.length) return outcome;
  const boxes = await listSandboxes();
  if (!boxes) return outcome;
  const root = resolve(repoRoot);
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const box of boxes) {
    const runId = isCezarSandboxName(box.name);
    if (!runId || (box.workspaces[0] ?? '') !== root) continue;
    const run = byId.get(runId);
    if (!run) {
      if (await removeSandbox(box.name)) {
        await hostGit(root, ['remote', 'remove', sandboxRemoteName(box.name)]);
        outcome.removed.push(box.name);
      }
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
