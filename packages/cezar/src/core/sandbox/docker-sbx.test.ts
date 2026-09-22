import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectSandbox, meetsMinimum, parseSbxVersion } from './docker-sbx.js';

const fakeSbx = fileURLToPath(new URL('../__fixtures__/sbx/fake-sbx.mjs', import.meta.url));
chmodSync(fakeSbx, 0o755);

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  // vitest.setup.ts defaults CEZ_SANDBOX=0 for hermetic health tests; these tests opt back in.
  CEZ_SANDBOX: '',
  CEZ_SBX_BIN: fakeSbx,
  ...extra,
});

describe('parseSbxVersion / meetsMinimum', () => {
  it('reads the CLI spellings', () => {
    expect(parseSbxVersion('v0.45.0')).toEqual([0, 45, 0]);
    expect(parseSbxVersion('0.46.2-rc1')).toEqual([0, 46, 2]);
    expect(parseSbxVersion('dev')).toBeNull();
  });

  it('compares numerically, not lexically', () => {
    expect(meetsMinimum('v0.45.0')).toBe(true);
    expect(meetsMinimum('v0.100.0')).toBe(true);
    expect(meetsMinimum('v1.0.0')).toBe(true);
    expect(meetsMinimum('v0.44.9')).toBe(false);
    expect(meetsMinimum('garbage')).toBe(false);
  });
});

describe('detectSandbox (against the fake sbx)', () => {
  it('reports available for a current sbx', async () => {
    expect(await detectSandbox(env())).toEqual({
      provider: 'docker-sbx',
      state: 'available',
      version: 'v0.45.0',
      backends: ['claude', 'codex'],
    });
  });

  it('reports unsupported-version for an old sbx, without probing further', async () => {
    expect(await detectSandbox(env({ FAKE_SBX_VERSION: 'v0.39.0' }))).toMatchObject({
      state: 'unsupported-version',
      version: 'v0.39.0',
    });
  });

  it('reports unsupported-version when a required create flag is gone', async () => {
    expect(await detectSandbox(env({ FAKE_SBX_BROKEN: 'help' }))).toMatchObject({ state: 'unsupported-version' });
  });

  it('is absent when sbx is not installed, fails, or CEZ_SANDBOX=0', async () => {
    expect(await detectSandbox(env({ CEZ_SBX_BIN: '/nonexistent/sbx' }))).toBeUndefined();
    expect(await detectSandbox(env({ FAKE_SBX_BROKEN: 'version' }))).toBeUndefined();
    expect(await detectSandbox(env({ CEZ_SANDBOX: '0' }))).toBeUndefined();
  });

  it('never runs anything when CEZ_SANDBOX=0', async () => {
    let calls = 0;
    await detectSandbox(env({ CEZ_SANDBOX: '0' }), async () => {
      calls++;
      return { ok: true, stdout: '', notFound: false };
    });
    expect(calls).toBe(0);
  });

  it('only ever runs the two passive probes', async () => {
    const seen: string[][] = [];
    await detectSandbox(env(), async (_bin, args) => {
      seen.push(args);
      return args[0] === 'version'
        ? { ok: true, stdout: JSON.stringify({ client: { version: 'v0.45.0' } }), notFound: false }
        : { ok: true, stdout: '--skills --pull --template', notFound: false };
    });
    expect(seen).toEqual([['version', '--json'], ['create', '--help']]);
  });
});
