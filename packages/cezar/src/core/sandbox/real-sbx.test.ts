import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sandboxLauncher, sandboxNameFor } from './docker-sbx.js';
import { commitInSandbox, prepareRunSandbox, sandboxForwardKeys, sandboxTmpEnv, syncBackFromSandbox } from './run-sandbox.js';

/**
 * Isolation, asserted against a REAL Docker Sandbox (spec 2026-09-22-docker-sandboxes, Phase 5).
 * Everything else in the suite runs against the fake sbx, which proves wiring and nothing about
 * isolation — this is the one place the boundary itself is checked.
 *
 * Opt-in: `CEZ_TEST_REAL_SBX=1 npm run test:real-sbx -w @open-mercato/cezar` on a host with a
 * signed-in `sbx` (and a one-time Claude `/login` in a sandbox). It creates one sandbox per run
 * of the suite and leaves it in place — remove it afterwards with the `sbx rm` line it logs.
 */
const REAL = process.env.CEZ_TEST_REAL_SBX === '1';
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

function inVm(name: string, cwd: string, script: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  const child = sandboxLauncher(name, sandboxForwardKeys(env)).spawn('bash', ['-c', script], { cwd, env });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

describe.skipIf(!REAL)('real Docker Sandbox isolation', () => {
  it('holds the boundary the design depends on', async () => {
    const runId = randomUUID();
    const name = sandboxNameFor(runId);
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cez-real-sbx-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'main-checkout-only.txt'), 'main');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', [...IDENTITY, 'commit', '-q', '-m', 'init'], { cwd: repo });
    const dataDir = join(repo, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'runs.json'), '[]');
    const wt = join(dataDir, 'worktrees', runId);
    execFileSync('git', ['worktree', 'add', '-q', '-b', `cez/${runId.slice(0, 8)}`, wt], { cwd: repo });

    // eslint-disable-next-line no-console
    console.log(`[real-sbx] sandbox ${name} for ${repo} — remove afterwards with: sbx rm --force ${name}`);
    const { created } = await prepareRunSandbox({ repoRoot: repo, dataDir, record: { id: runId, sandbox: { name }, worktreePath: wt }, backend: 'claude' });
    expect(created).toBe(true);

    const env = { ...process.env, CEZ_TASK_ID: runId, ...sandboxTmpEnv(runId), GH_TOKEN: 'ghp_must_not_cross', ANTHROPIC_API_KEY: 'sk-must-not-cross' };
    const branch = `cez/${runId.slice(0, 8)}`;

    // 1. Host env values never cross, and the VM works in its own clone of the branch.
    const seen = await inVm(
      name,
      repo,
      [
        'echo "gh=${GH_TOKEN:-none} key=${ANTHROPIC_API_KEY:-none} task=$CEZ_TASK_ID sbx=$SANDBOX_NAME"',
        'git status --short --branch | head -1',
        // The clone is the VM's own repository, not a bind mount of the host's.
        'git rev-parse --show-toplevel',
      ].join('; '),
      env,
    );
    // (sbx sets its OWN proxy-managed placeholder GH_TOKEN, `gho_sbxproxymanaged…`, which only
    // becomes a real token if the user stored an sbx `github` secret — the README warns against
    // that for cezar runs.)
    expect(seen.out).not.toContain('ghp_must_not_cross');
    expect(seen.out).toContain(`key=none task=${runId} sbx=${name}`);
    expect(seen.out).toContain(branch);

    // 2. THE boundary: the VM cannot write anything on the host — not the repo, not `.git`, not
    // another worktree's admin dir — even as root. Under `--clone` there is no host `.git` mount
    // to hold read-only piecemeal; the host repo is read-only in its entirety at /run/sandbox/source.
    const writes = await inVm(
      name,
      repo,
      [
        `sudo -n sh -c 'echo "[core] fsmonitor = /tmp/pwn" >> /run/sandbox/source/.git/config' 2>/dev/null && echo CONFIG_WRITTEN`,
        `sudo -n sh -c 'echo x > /run/sandbox/source/.git/hooks/pre-commit' 2>/dev/null && echo HOOK_WRITTEN`,
        `for f in /run/sandbox/source/.git/worktrees/*/commondir; do sudo -n sh -c "echo /evil > $f" 2>/dev/null && echo COMMONDIR_WRITTEN; done`,
        `sudo -n sh -c 'echo x > /run/sandbox/source/main-checkout-only.txt' 2>/dev/null && echo CHECKOUT_WRITTEN`,
        // …while the agent can still commit its work, in its own clone.
        `echo agent > agent.txt && git add agent.txt && git ${IDENTITY.join(' ')} commit -qm 'from the vm' && echo COMMITTED`,
      ].join('; '),
      env,
    );
    expect(writes.out).not.toMatch(/CONFIG_WRITTEN|HOOK_WRITTEN|COMMONDIR_WRITTEN|CHECKOUT_WRITTEN/);
    expect(writes.out).toContain('COMMITTED');
    expect(readFileSync(join(repo, '.git/config'), 'utf8')).not.toContain('fsmonitor');
    // Nothing the VM did reached the host's own copy of the tree.
    expect(readFileSync(join(repo, 'main-checkout-only.txt'), 'utf8')).toBe('main');

    // 3. Work comes back the other way: uncommitted work is committed inside the VM, then the
    // host fast-forwards the task branch onto what the VM produced.
    const record = { id: runId, sandbox: { name }, worktreePath: wt, branch };
    await inVm(name, repo, 'echo later > uncommitted.txt', env);
    expect(await commitInSandbox(record, repo, 'cezar autosave (turn end)')).toBe(true);
    expect(await syncBackFromSandbox(repo, record)).toBe(true);
    const log = execFileSync('git', ['log', '--format=%s', branch], { cwd: repo, encoding: 'utf8' });
    expect(log).toContain('from the vm');
    expect(log).toMatch(/autosave/);
    expect(readFileSync(join(wt, 'agent.txt'), 'utf8').trim()).toBe('agent');
    expect(readFileSync(join(wt, 'uncommitted.txt'), 'utf8').trim()).toBe('later');
  }, 300_000);
});

/**
 * The whole feature end to end: the real engine, a real sandbox, the real Claude CLI inside it.
 * Spends a little of the signed-in Claude quota, so it needs its own opt-in on top of the suite's:
 * `CEZ_TEST_REAL_SBX_AGENT=1`.
 */
describe.skipIf(!REAL || process.env.CEZ_TEST_REAL_SBX_AGENT !== '1')('real Docker Sandbox — a sandboxed run with real Claude', () => {
  it('the agent edits its worktree inside the VM, the check step runs there too, and the VM stops', async () => {
    const { RunStore } = await import('../../runs/store.js');
    const { RunManager } = await import('../../workflows/run.js');
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cez-real-sbx-run-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
    const store = RunStore.open(join(repo, '.ai/cezar'));
    const manager = new RunManager(store, repo);
    const record = manager.startRun(
      {
        name: 'real-sbx-e2e',
        source: 'built-in',
        steps: [
          { id: 'work', prompt: 'Create a file named hello.txt in the current directory containing exactly the word sandboxed. Do nothing else.' },
          { id: 'check', command: 'test "$(cat hello.txt)" = sandboxed && test -n "$SANDBOX_NAME" && echo "checked in $SANDBOX_NAME"' },
        ],
      },
      { task: 'real sandbox e2e', sandbox: true, autonomous: true },
    );
    // eslint-disable-next-line no-console
    console.log(`[real-sbx] run ${record.id} in ${repo} — remove afterwards with: sbx rm --force cez-${record.id}`);
    const deadline = Date.now() + 8 * 60_000;
    while (!['done', 'failed', 'review', 'cancelled'].includes(store.getRun(record.id)?.status ?? '') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const run = store.getRun(record.id);
    const notes = store.readEvents(record.id).filter((e) => e.type === 'check-output' || e.type === 'lifecycle' || e.type === 'error');
    // eslint-disable-next-line no-console
    console.log('[real-sbx] events:', JSON.stringify(notes.map((e) => ({ type: e.type, text: (e as { text?: string }).text, message: (e as { message?: string }).message }))));
    expect(run?.error).toBeUndefined();
    expect(['done', 'review']).toContain(run?.status);
    expect(readFileSync(join(run?.worktreePath ?? '', 'hello.txt'), 'utf8').trim()).toBe('sandboxed');
    expect(JSON.stringify(notes)).toContain(`checked in cez-${record.id}`);
    store.flush();
  }, 600_000);
});
