import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetSandboxDetectionCache } from '../core/sandbox/docker-sbx.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `capabilities.sandbox` (spec 2026-09-22-docker-sandboxes) — additive and optional on the
 * CORS-open health payload (BACKWARD_COMPATIBILITY.md §2): present only when `sbx` is found.
 */
describe('GET /api/v1/health — capabilities.sandbox', () => {
  const fakeSbx = fileURLToPath(new URL('../core/__fixtures__/sbx/fake-sbx.mjs', import.meta.url));
  const saved = { sandbox: process.env.CEZ_SANDBOX, bin: process.env.CEZ_SBX_BIN, dryRun: process.env.CEZ_DRY_RUN };

  beforeEach(() => {
    chmodSync(fakeSbx, 0o755);
    process.env.CEZ_DRY_RUN = '1';
    resetSandboxDetectionCache();
  });

  afterEach(() => {
    for (const [key, value] of [
      ['CEZ_SANDBOX', saved.sandbox],
      ['CEZ_SBX_BIN', saved.bin],
      ['CEZ_DRY_RUN', saved.dryRun],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSandboxDetectionCache();
  });

  const capabilities = async (): Promise<Record<string, unknown>> => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cez-health-sbx-'));
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/health');
    expect(res.status).toBe(200);
    store.flush();
    return ((await res.json()) as { capabilities: Record<string, unknown> }).capabilities;
  };

  it('reports the detected sbx', async () => {
    process.env.CEZ_SANDBOX = '';
    process.env.CEZ_SBX_BIN = fakeSbx;
    expect((await capabilities()).sandbox).toEqual({
      provider: 'docker-sbx',
      state: 'available',
      version: 'v0.45.0',
      backends: ['claude', 'codex'],
    });
  });

  it('omits the key entirely — not `undefined` — when sbx is absent', async () => {
    process.env.CEZ_SANDBOX = '';
    process.env.CEZ_SBX_BIN = '/nonexistent/sbx';
    expect(await capabilities()).not.toHaveProperty('sandbox');
  });

  it('omits it with CEZ_SANDBOX=0 even when sbx is installed', async () => {
    process.env.CEZ_SANDBOX = '0';
    process.env.CEZ_SBX_BIN = fakeSbx;
    expect(await capabilities()).not.toHaveProperty('sandbox');
  });
});
