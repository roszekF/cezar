import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxCapability } from '@open-mercato/cezar-contract';
import { listSandboxes, sandboxLauncher } from './docker-sbx.js';
import { sandboxRunRefusal, type SandboxRunRequest } from './run-policy.js';
import { prepareRunSandbox, reconcileSandboxes, sandboxAgentSpec, sandboxForwardKeys } from './run-sandbox.js';
import { sandboxGitEnv, unregisterSandboxedWorktree } from './sandbox-git.js';

const fakeSbx = fileURLToPath(new URL('../__fixtures__/sbx/fake-sbx.mjs', import.meta.url));
chmodSync(fakeSbx, 0o755);
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const RUN_ID = '11111111-2222-4333-8444-555555555555';

const available: SandboxCapability = { provider: 'docker-sbx', state: 'available', version: 'v0.45.0', backends: ['claude', 'codex'] };

describe('sandboxRunRefusal', () => {
  const ok: SandboxRunRequest = {
    capability: available,
    backends: ['claude'],
    dispatch: false,
    isGitRepo: true,
    worktreeConfig: false,
  };

  it('accepts a plain Claude or Codex run', () => {
    expect(sandboxRunRefusal(ok)).toBeUndefined();
    expect(sandboxRunRefusal({ ...ok, backends: ['codex', 'codex'] })).toBeUndefined();
  });

  it.each([
    ['no sbx', { capability: undefined }, /install `sbx`/],
    ['old sbx', { capability: { ...available, state: 'unsupported-version' as const } }, /not supported/],
    ['no git repo', { isGitRepo: false }, /git repository/],
    ['worktree off', { worktree: false }, /need a worktree/],
    ['opencode', { backends: ['opencode'] }, /Claude and Codex only.*opencode/],
    ['pi', { backends: ['claude', 'pi'] }, /Claude and Codex only.*pi/],
    ['mixed kits', { backends: ['claude', 'codex'] }, /mixes Claude and Codex/],
    ['account override', { agentProfile: 'work' }, /sandbox login/],
    ['dispatch', { dispatch: true }, /cannot dispatch/],
    ['worktreeConfig', { worktreeConfig: true }, /extensions\.worktreeConfig/],
  ])('refuses %s, saying what to change', (_label, patch, message) => {
    expect(sandboxRunRefusal({ ...ok, ...patch })).toMatch(message);
  });
});

/** A repo with a cezar-shaped worktree, and the fake sbx pointed at a fresh state file. */
function setup(): { repo: string; wt: string; dataDir: string; state: string; log: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cez-runsbx-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  const wt = join(repo, '.ai/cezar/worktrees', RUN_ID);
  execFileSync('git', ['worktree', 'add', '-q', '-b', `cez/${RUN_ID.slice(0, 8)}`, wt], { cwd: repo });
  return { repo, wt, dataDir: join(repo, '.ai/cezar'), state: join(repo, 'sbx-state.json'), log: join(repo, 'sbx-exec.ndjson') };
}

describe('prepareRunSandbox / reconcile (fake sbx)', () => {
  const saved = { bin: process.env.CEZ_SBX_BIN, state: process.env.FAKE_SBX_STATE, log: process.env.FAKE_SBX_EXEC_LOG, broken: process.env.FAKE_SBX_BROKEN };
  let fx: ReturnType<typeof setup>;

  beforeEach(() => {
    fx = setup();
    process.env.CEZ_SBX_BIN = fakeSbx;
    process.env.FAKE_SBX_STATE = fx.state;
    process.env.FAKE_SBX_EXEC_LOG = fx.log;
    delete process.env.FAKE_SBX_BROKEN;
  });
  afterEach(() => {
    unregisterSandboxedWorktree(fx.wt);
    for (const [key, value] of Object.entries({ CEZ_SBX_BIN: saved.bin, FAKE_SBX_STATE: saved.state, FAKE_SBX_EXEC_LOG: saved.log, FAKE_SBX_BROKEN: saved.broken })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const record = () => ({ id: RUN_ID, sandbox: { name: `cez-${RUN_ID}` }, worktreePath: fx.wt });

  it('creates the VM once, mounting the worktree and a hardened .git — never the main checkout', async () => {
    expect(await prepareRunSandbox({ repoRoot: fx.repo, dataDir: fx.dataDir, record: record(), backend: 'claude' })).toEqual({ created: true });
    expect(await prepareRunSandbox({ repoRoot: fx.repo, dataDir: fx.dataDir, record: record(), backend: 'claude' })).toEqual({ created: false });

    const [box] = (await listSandboxes()) ?? [];
    expect(box?.name).toBe(`cez-${RUN_ID}`);
    const ws = box?.workspaces ?? [];
    expect(ws[0]).toBe(fx.wt);
    expect(ws).toContain(join(fx.repo, '.git'));
    for (const held of ['config', 'hooks', 'info']) expect(ws).toContain(`${join(fx.repo, '.git', held)}:ro`);
    expect(ws.some((w) => w.endsWith('/commondir:ro'))).toBe(true);
    expect(ws.some((w) => w.endsWith('/gitdir:ro'))).toBe(true);
    expect(ws).toContain(join(fx.dataDir, 'sandbox', RUN_ID));
    expect(ws).not.toContain(fx.repo);
    expect(ws).not.toContain(fx.dataDir);
    // …and host git on the worktree is hardened from here on.
    expect(sandboxGitEnv(fx.wt)?.GIT_WORK_TREE).toBe(fx.wt);
  });

  it('replaces a crash-left sandbox whose primary workspace does not match', async () => {
    writeFileSync(fx.state, JSON.stringify({ sandboxes: [{ name: `cez-${RUN_ID}`, status: 'stopped', workspaces: ['/elsewhere'] }] }));
    expect(await prepareRunSandbox({ repoRoot: fx.repo, dataDir: fx.dataDir, record: record(), backend: 'claude' })).toEqual({ created: true });
    expect((await listSandboxes())?.[0]?.workspaces[0]).toBe(fx.wt);
  });

  it('throws a readable error when sbx create fails (e.g. signed out)', async () => {
    process.env.FAKE_SBX_BROKEN = 'create';
    await expect(prepareRunSandbox({ repoRoot: fx.repo, dataDir: fx.dataDir, record: record(), backend: 'claude' })).rejects.toThrow(
      /sbx create failed: .*Not authenticated/,
    );
  });

  it('refuses a backend with no sandbox kit, and a run without a worktree', async () => {
    await expect(prepareRunSandbox({ repoRoot: fx.repo, dataDir: fx.dataDir, record: record(), backend: 'opencode' })).rejects.toThrow(/Claude and Codex only/);
    await expect(
      prepareRunSandbox({ repoRoot: fx.repo, dataDir: fx.dataDir, record: { ...record(), worktreePath: undefined }, backend: 'claude' }),
    ).rejects.toThrow(/needs its worktree/);
  });

  it('reconcile removes this repo’s orphans, stops leftovers, and never touches another project', async () => {
    const orphan = 'cez-99999999-2222-4333-8444-555555555555';
    const foreign = 'cez-88888888-2222-4333-8444-555555555555';
    writeFileSync(
      fx.state,
      JSON.stringify({
        sandboxes: [
          { name: `cez-${RUN_ID}`, status: 'running', workspaces: [fx.wt] },
          { name: orphan, status: 'stopped', workspaces: [join(fx.dataDir, 'worktrees', 'gone')] },
          { name: foreign, status: 'running', workspaces: ['/other/project/.ai/cezar/worktrees/x'] },
          { name: 'my-own-box', status: 'running', workspaces: [fx.wt] },
        ],
      }),
    );
    const outcome = await reconcileSandboxes(fx.repo, [{ ...record(), status: 'failed' }]);
    expect(outcome).toEqual({ removed: [orphan], stopped: [`cez-${RUN_ID}`] });
    const left = new Map((await listSandboxes())?.map((s) => [s.name, s.status]));
    expect(left.get(foreign)).toBe('running');
    expect(left.get('my-own-box')).toBe('running');
    expect(left.has(orphan)).toBe(false);
  });

  it('reconcile never calls sbx when the repo has no sandboxed runs', async () => {
    process.env.CEZ_SBX_BIN = '/nonexistent/sbx-must-not-run';
    expect(await reconcileSandboxes(fx.repo, [{ id: RUN_ID }])).toEqual({ removed: [], stopped: [] });
  });

  it('the launcher forwards only the named env, by name — values never in argv', async () => {
    await prepareRunSandbox({ repoRoot: fx.repo, dataDir: fx.dataDir, record: record(), backend: 'claude' });
    const launcher = sandboxLauncher(`cez-${RUN_ID}`, sandboxForwardKeys({}));
    const child = launcher.spawn('node', ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      cwd: fx.wt,
      env: { ...process.env, CEZ_TASK_ID: RUN_ID, TMPDIR: '/tmp/x', GH_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: 'sk-secret' },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    await new Promise((resolve) => child.on('close', resolve));
    const inner = JSON.parse(out) as Record<string, string>;
    expect(inner.CEZ_TASK_ID).toBe(RUN_ID);
    expect(inner.GH_TOKEN).toBeUndefined();
    expect(inner.ANTHROPIC_API_KEY).toBeUndefined();
    const logged = JSON.parse(readFileSync(fx.log, 'utf8').trim().split('\n').at(-1) ?? '{}') as { env: Record<string, string> };
    expect(Object.keys(logged.env).sort()).toEqual(['CEZ_TASK_ID', 'HOME', 'PATH', 'TMPDIR']);
    // The host process table sees names, not values.
    for (const value of ['/tmp/x', 'ghp_secret', 'sk-secret']) expect(child.spawnargs.join(' ')).not.toContain(value);
    expect(child.spawnargs).toContain('CEZ_TASK_ID');
  });
});

describe('sandboxAgentSpec', () => {
  it('moves the spec into the VM: own env, VM-visible dirs, fresh session after a recreate', () => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cez-spec-')));
    const base = { userPrompt: 'go', cwd: '/wt', env: { CEZ_TASK_ID: RUN_ID, CEZ_TODOS_FILE: '/x/todos.json' }, resume: true, sessionId: 's' };
    const kept = sandboxAgentSpec(base, { name: `cez-${RUN_ID}`, dataDir, runId: RUN_ID, backend: 'claude', created: false });
    expect(kept.restartedSession).toBe(false);
    expect(kept.spec.resume).toBe(true);
    expect(kept.spec.launcher?.kind).toBe('sandbox');
    expect(kept.spec.env?.CEZ_TODOS_FILE).toBe('');
    expect(kept.spec.env?.CLAUDE_CODE_TMPDIR).toBe(join(dataDir, 'sandbox', RUN_ID, 'tmp'));
    expect(existsSync(kept.spec.env?.CLAUDE_CODE_TMPDIR ?? '')).toBe(true);
    expect(kept.spec.additionalDirectories).toEqual([join(dataDir, 'sandbox', RUN_ID)]);

    const fresh = sandboxAgentSpec(base, { name: `cez-${RUN_ID}`, dataDir, runId: RUN_ID, backend: 'claude', created: true });
    expect(fresh.restartedSession).toBe(true);
    expect(fresh.spec.resume).toBe(false);
  });
});
