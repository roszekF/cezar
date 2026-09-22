import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cezarHomeDir } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * A sandboxed run end to end through the engine (spec 2026-09-22-docker-sandboxes, Phase 4),
 * against the fake `sbx` — which runs commands locally but, like the real VM, hands the process
 * ONLY the env `-e` forwards. It proves the wiring (every spawn goes through `sbx exec`, the
 * env is the run's own, the VM is stopped at the end), not isolation: that is Phase 5's suite.
 */
const fakeSbx = fileURLToPath(new URL('../core/__fixtures__/sbx/fake-sbx.mjs', import.meta.url));
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const KEYS = ['CEZ_SBX_BIN', 'FAKE_SBX_STATE', 'FAKE_SBX_EXEC_LOG', 'CEZ_DRY_RUN', 'GH_TOKEN', 'CEZ_AUTONAME', 'CEZ_ENV_PASSTHROUGH', 'DATABASE_URL'] as const;

interface Exec {
  name: string;
  cwd: string;
  bin: string;
  args: string[];
  env: Record<string, string>;
}

async function waitFor(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('RunManager — a sandboxed run (fake sbx)', () => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  let root: string;
  let state: string;
  let log: string;

  beforeEach(() => {
    chmodSync(fakeSbx, 0o755);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-sbx-run-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
    state = join(root, '..', `${root.split('/').at(-1)}-sbx-state.json`);
    log = join(root, '..', `${root.split('/').at(-1)}-sbx-exec.ndjson`);
    process.env.CEZ_SBX_BIN = fakeSbx;
    process.env.FAKE_SBX_STATE = state;
    process.env.FAKE_SBX_EXEC_LOG = log;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_AUTONAME = '0';
    // A host secret the sandbox must never see.
    process.env.GH_TOKEN = 'ghp_host_secret';
    // …and one the user explicitly lets through for check steps.
    process.env.CEZ_ENV_PASSTHROUGH = 'DATABASE_URL';
    process.env.DATABASE_URL = 'postgres://check';
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const execs = (): Exec[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Exec) : [];
  const boxes = (): Array<{ name: string; status: string; workspaces: string[] }> =>
    existsSync(state) ? (JSON.parse(readFileSync(state, 'utf8')) as { sandboxes: [] }).sandboxes : [];

  it('runs the agent AND the check step inside its sandbox, with only its own env, then stops the VM', async () => {
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    const workflow: WorkflowDef = {
      name: 'sandboxed',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: 'do the task: {{task}}' },
        {
          id: 'check',
          command:
            'node -e "require(\'node:fs\').writeFileSync(\'check-ran\', process.env.SANDBOX_NAME + \'|\' + (process.env.GH_TOKEN ?? \'none\') + \'|\' + process.env.DATABASE_URL)"',
        },
      ],
    };

    const record = manager.startRun(workflow, { task: 'sandboxed task', sandbox: true });
    const name = `cez-${record.id}`;
    expect(store.getRun(record.id)?.sandbox).toEqual({ provider: 'docker-sbx', name });
    // Follow-ups can't reach the shared inbox from a VM.
    expect(store.getRun(record.id)?.generateFollowups).toBe(false);

    await waitFor(() => ['done', 'failed', 'review', 'cancelled'].includes(store.getRun(record.id)?.status ?? ''), 'the run to settle');
    const run = store.getRun(record.id);
    expect(run?.error).toBeUndefined();
    expect(run?.status).not.toBe('failed');
    expect(run?.sandbox?.createdAt).toBeDefined();

    // Both steps went through `sbx exec` in this run's sandbox, in the VM's clone — which sits
    // at the REPO ROOT path, because the task worktree is a host-side artifact and is not mounted.
    const ran = execs();
    expect(ran.map((e) => e.name)).toEqual(ran.map(() => name));
    expect(ran.some((e) => e.bin === 'bash' && e.args.join(' ').includes('check-ran'))).toBe(true);
    expect(ran.some((e) => e.bin !== 'bash' && e.bin !== 'git')).toBe(true); // the agent
    for (const exec of ran) {
      expect(exec.cwd).toBe(root);
      expect(exec.env.GH_TOKEN).toBeUndefined();
      expect(
        Object.keys(exec.env).every((k) =>
          ['PATH', 'HOME', 'CEZ_HANDOFF_FILE', 'CEZ_TASK_ID', 'CEZ_TODOS_FILE', 'TMPDIR', 'TEMP', 'TMP', 'CLAUDE_CODE_TMPDIR', 'DATABASE_URL'].includes(k),
        ),
      ).toBe(true);
    }
    // The check saw the sandbox, not the host. It runs in the VM's clone, at the repo root path.
    expect(readFileSync(join(root, 'check-ran'), 'utf8')).toBe(`${name}|none|postgres://check`);

    // The journal lives OUTSIDE the repo: nothing inside the cloned path can be mounted.
    // `git` execs are the clone's one-time setup (identity + branch checkout), not a step.
    expect(ran.filter((e) => e.bin === 'git').map((e) => e.args[0])).toEqual(['config', 'config', 'checkout']);
    const agent = ran.find((e) => e.bin !== 'bash' && e.bin !== 'git');
    expect(agent?.env.CEZ_HANDOFF_FILE).toBe(join(cezarHomeDir(), 'sandbox', record.id, 'handoff.md'));
    expect(existsSync(agent?.env.CEZ_HANDOFF_FILE ?? '')).toBe(true);

    // One VM, mounted per the spec, stopped once the run settled.
    await waitFor(() => boxes().find((b) => b.name === name)?.status === 'stopped', 'the VM to stop');
    const box = boxes().find((b) => b.name === name);
    expect(boxes()).toHaveLength(1);
    // The repo is the clone SOURCE and the primary workspace; nothing under it is mounted.
    expect(box?.workspaces[0]).toBe(root);
    expect(box?.workspaces).not.toContain(run?.worktreePath);
    expect(box?.workspaces.some((w) => w.startsWith(join(root, '.git')))).toBe(false);
    store.flush();
  }, 30_000);

  it('fails the step with a readable error when the sandbox cannot be created', async () => {
    process.env.FAKE_SBX_BROKEN = 'create';
    try {
      const store = RunStore.open(join(root, '.ai/cezar'));
      const manager = new RunManager(store, root);
      const workflow: WorkflowDef = { name: 'w', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}' }] };
      const record = manager.startRun(workflow, { task: 't', sandbox: true });
      await waitFor(() => store.getRun(record.id)?.status === 'failed', 'the run to fail');
      expect(store.getRun(record.id)?.error ?? '').toMatch(/sandbox: sbx create failed/);
      // Nothing ran anywhere — least of all on the host.
      expect(execs()).toEqual([]);
      store.flush();
      const wt = store.getRun(record.id)?.worktreePath;
    } finally {
      delete process.env.FAKE_SBX_BROKEN;
    }
  }, 30_000);
});
