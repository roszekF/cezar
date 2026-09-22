import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autosaveCommit } from '../../git-worktree.js';
import { sandboxLauncher, sandboxNameFor } from './docker-sbx.js';
import { prepareRunSandbox, sandboxForwardKeys, sandboxTmpEnv } from './run-sandbox.js';

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
    const hostHooks = join(repo, '.git/hooks');

    // eslint-disable-next-line no-console
    console.log(`[real-sbx] sandbox ${name} for ${repo} — remove afterwards with: sbx rm --force ${name}`);
    const { created } = await prepareRunSandbox({ repoRoot: repo, dataDir, record: { id: runId, sandbox: { name }, worktreePath: wt }, backend: 'claude' });
    expect(created).toBe(true);

    const env = { ...process.env, CEZ_TASK_ID: runId, ...sandboxTmpEnv(dataDir, runId), GH_TOKEN: 'ghp_must_not_cross', ANTHROPIC_API_KEY: 'sk-must-not-cross' };

    // 1. What the VM can see.
    const seen = await inVm(
      name,
      wt,
      [
        `test -e ${JSON.stringify(join(repo, 'main-checkout-only.txt'))} && echo MAIN_VISIBLE`,
        `test -e ${JSON.stringify(join(dataDir, 'runs.json'))} && echo RUNS_JSON_VISIBLE`,
        `test -e ${JSON.stringify(join(homedir(), '.ssh'))} && echo HOST_SSH_VISIBLE`,
        `test -e ${JSON.stringify(homedir())} && echo HOST_HOME_VISIBLE`,
        'echo "gh=${GH_TOKEN:-none} key=${ANTHROPIC_API_KEY:-none} task=$CEZ_TASK_ID sbx=$SANDBOX_NAME"',
        'git status --short --branch | head -1',
      ].join('; '),
      env,
    );
    expect(seen.out).not.toMatch(/MAIN_VISIBLE|RUNS_JSON_VISIBLE|HOST_SSH_VISIBLE|HOST_HOME_VISIBLE/);
    // The host's values never cross. (sbx sets its OWN proxy-managed placeholder GH_TOKEN,
    // `gho_sbxproxymanaged…`, which only becomes a real token if the user stored an sbx
    // `github` secret — the README warns against that for cezar runs.)
    expect(seen.out).not.toContain('ghp_must_not_cross');
    expect(seen.out).toContain(`key=none task=${runId} sbx=${name}`);
    expect(seen.out).toContain(`cez/${runId.slice(0, 8)}`);

    // 2. The files that would make HOST git execute something are read-only — even for root.
    const writes = await inVm(
      name,
      wt,
      [
        `sudo -n sh -c 'echo "[core] fsmonitor = /tmp/pwn" >> ${join(repo, '.git/config')}' 2>/dev/null && echo CONFIG_WRITTEN`,
        `sudo -n sh -c 'echo x > ${join(hostHooks, 'pre-commit')}' 2>/dev/null && echo HOOK_WRITTEN`,
        `for f in ${join(repo, '.git/worktrees')}/*/commondir; do sudo -n sh -c "echo /evil > $f" 2>/dev/null && echo COMMONDIR_WRITTEN; done`,
        // …while the agent can still commit its work.
        `echo agent > agent.txt && git add agent.txt && git ${IDENTITY.join(' ')} commit -qm 'from the vm' && echo COMMITTED`,
        // …and CAN rewrite its gitlink, which is what host-git hardening is for.
        "echo 'gitdir: /evil' > .git && echo GITLINK_REWRITTEN",
      ].join('; '),
      env,
    );
    expect(writes.out).not.toMatch(/CONFIG_WRITTEN|HOOK_WRITTEN|COMMONDIR_WRITTEN/);
    expect(writes.out).toContain('COMMITTED');
    expect(writes.out).toContain('GITLINK_REWRITTEN');
    expect(readFileSync(join(repo, '.git/config'), 'utf8')).not.toContain('fsmonitor');

    // 3. Host autosave on the tampered worktree still lands on the right branch.
    writeFileSync(join(wt, 'host-side.txt'), 'x');
    expect(await autosaveCommit(wt, 'turn end')).toBe('committed');
    const log = execFileSync('git', ['log', '--format=%s', `cez/${runId.slice(0, 8)}`], { cwd: repo, encoding: 'utf8' });
    expect(log).toContain('from the vm');
    expect(log).toMatch(/autosave/);
  }, 300_000);
});
