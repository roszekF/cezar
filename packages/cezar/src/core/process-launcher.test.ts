import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeCliRunner } from './claude-cli-runner.js';
import { CodexAppServerRunner } from './codex-app-server-runner.js';
import { hostLauncher, type ProcessLauncher } from './process-launcher.js';

/** Records every spawn, then starts a real child through the host launcher. */
function recordingLauncher(): { launcher: ProcessLauncher; calls: Array<{ bin: string; args: readonly string[]; cwd: string }> } {
  const calls: Array<{ bin: string; args: readonly string[]; cwd: string }> = [];
  return {
    calls,
    launcher: {
      kind: 'sandbox',
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, cwd: opts.cwd });
        return hostLauncher.spawn(bin, args, opts);
      },
    },
  };
}

describe('hostLauncher', () => {
  it('starts the process in the given cwd with exactly the given env', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cez-launcher-')));
    const child = hostLauncher.spawn(
      process.execPath,
      ['-e', 'process.stdout.write(process.cwd() + "|" + process.env.CEZ_LAUNCHER_PROBE + "|" + (process.env.CEZ_LAUNCHER_ABSENT ?? "none"))'],
      { cwd, env: { PATH: process.env.PATH, CEZ_LAUNCHER_PROBE: 'yes' } },
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(out).toBe(`${cwd}|yes|none`);
  });
});

describe('runners spawn through spec.launcher', () => {
  it('Claude: the injected launcher receives the resolved binary, stream-json args and cwd', async () => {
    const stubBin = fileURLToPath(new URL('./__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url));
    const { launcher, calls } = recordingLauncher();
    const session = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 }).startSession({
      userPrompt: 'do it',
      cwd: process.cwd(),
      launcher,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe(stubBin);
    expect(calls[0]?.args).toContain('--output-format');
    expect(calls[0]?.cwd).toBe(process.cwd());
    session.interrupt();
    await session.result.catch(() => undefined);
  });

  it('Codex: the injected launcher receives `app-server` and cwd', async () => {
    const mockBin = fileURLToPath(new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url));
    const { launcher, calls } = recordingLauncher();
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'do it', cwd: process.cwd(), launcher },
      (event) => {
        if (event.type === 'text') sawText();
      },
    );
    expect(calls).toEqual([{ bin: mockBin, args: ['app-server'], cwd: process.cwd() }]);
    // Interrupt only lands once a turn is live — the same wait the #703 test uses.
    await firstText;
    session.interrupt();
    await session.result;
  }, 15_000);
});
