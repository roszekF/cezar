import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetSandboxDetectionCache } from '../core/sandbox/docker-sbx.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp, resumeCommand } from './server.ts';

/** `POST /runs` with `sandbox: true` (spec 2026-09-22-docker-sandboxes): one policy, a 400 naming the fix. */
describe('POST /api/v1/runs — sandbox', () => {
  const fakeSbx = fileURLToPath(new URL('../core/__fixtures__/sbx/fake-sbx.mjs', import.meta.url));
  const saved = { sandbox: process.env.CEZ_SANDBOX, bin: process.env.CEZ_SBX_BIN, dry: process.env.CEZ_DRY_RUN };
  let repoRoot: string;
  let app: Hono;
  let store: RunStore;
  let captured: StartRunInput | undefined;

  beforeEach(() => {
    chmodSync(fakeSbx, 0o755);
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_SANDBOX = '';
    process.env.CEZ_SBX_BIN = fakeSbx;
    resetSandboxDetectionCache();
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-sbx-route-')));
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    for (const [key, value] of [
      ['CEZ_SANDBOX', saved.sandbox],
      ['CEZ_SBX_BIN', saved.bin],
      ['CEZ_DRY_RUN', saved.dry],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSandboxDetectionCache();
  });

  const post = (body: Record<string, unknown>) =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'x', steps: [{ id: 'a', prompt: '{{task}}' }], ...body }),
    });

  it('hands a qualifying run to the engine with sandbox: true', async () => {
    const res = await post({ sandbox: true });
    expect(res.status).toBe(201);
    expect(captured?.sandbox).toBe(true);
  });

  it('leaves an ordinary run exactly as before', async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    expect(captured).not.toHaveProperty('sandbox');
  });

  it('refuses when sbx is not there, or CEZ_SANDBOX=0', async () => {
    process.env.CEZ_SANDBOX = '0';
    resetSandboxDetectionCache();
    const res = await post({ sandbox: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/install `sbx`/);
    expect(captured).toBeUndefined();
  });

  it('refuses worktree off and a non-sandboxable backend', async () => {
    expect((await post({ sandbox: true, worktree: false })).status).toBe(400);
    const opencode = await post({ sandbox: true, steps: [{ id: 'a', prompt: 'x', runner: 'opencode' }] });
    expect(opencode.status).toBe(400);
    expect(captured).toBeUndefined();
  });
});

describe('resumeCommand — sandboxed session', () => {
  const name = 'cez-11111111-2222-4333-8444-555555555555';

  it('resumes inside the sandbox, with no path in the string', () => {
    expect(resumeCommand('claude', 'abc-123', name)).toBe(`sbx exec -it ${name} claude --resume abc-123`);
    expect(resumeCommand('codex', 'abc-123', name)).toBe(`sbx exec -it ${name} codex resume abc-123`);
  });

  it('fails closed on a name cezar did not mint', () => {
    expect(resumeCommand('claude', 'abc-123', 'cez-x; rm -rf ~')).toBeNull();
    expect(resumeCommand('claude', 'abc-123', 'my-box')).toBeNull();
  });

  it('is unchanged for a host run', () => {
    expect(resumeCommand('claude', 'abc-123')).toBe('claude --resume abc-123');
  });
});
