import { execFile } from 'node:child_process';
import type { SandboxCapability } from '@open-mercato/cezar-contract';

/**
 * Docker Sandboxes (`sbx`) — the only module that runs the `sbx` CLI (spec
 * 2026-09-22-docker-sandboxes). This file holds detection; sandbox lifecycle lands with
 * sandboxed runs.
 *
 * Detection is passive by design (§ Zero config): `sbx version --json` reports the daemon
 * as `unavailable` rather than starting it, and `sbx create --help` is pure help text — the
 * Phase 0 spike (check j) confirmed neither spawns `sandboxd`. Merely having `sbx`
 * installed must never leave a background process behind. Sign-in state needs the daemon,
 * so it is deliberately not probed here.
 */

/** The version the Phase 0 spike verified (`:ro` single-path hold-outs, `--skills`, `--pull`). */
export const MIN_SBX_VERSION = '0.45.0';

/** Flags `sbx create` must offer; a release that drops one is `unsupported-version`. */
const REQUIRED_CREATE_FLAGS = ['--skills', '--pull', '--template'];

const PROBE_TIMEOUT_MS = 5_000;

export function resolveSbxExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.CEZ_SBX_BIN ?? 'sbx';
}

type Run = (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ ok: boolean; stdout: string; notFound: boolean }>;

const defaultRun: Run = (bin, args, env) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', env }, (err, stdout) =>
      resolve({
        ok: !err,
        stdout: stdout ?? '',
        notFound: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT',
      }),
    );
  });

/** `v0.45.0` / `0.45.0-rc1` → [0, 45, 0]; anything else → null. */
export function parseSbxVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function meetsMinimum(version: string, minimum = MIN_SBX_VERSION): boolean {
  const have = parseSbxVersion(version);
  const need = parseSbxVersion(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return (have[i] ?? 0) > (need[i] ?? 0);
  }
  return true;
}

/**
 * Probe the host once. `undefined` means "no sandbox support here": `sbx` is not installed,
 * its version output is unreadable, or `CEZ_SANDBOX=0` switched the feature off.
 */
export async function detectSandbox(
  env: NodeJS.ProcessEnv = process.env,
  run: Run = defaultRun,
): Promise<SandboxCapability | undefined> {
  if (env.CEZ_SANDBOX === '0') return undefined;
  const bin = resolveSbxExecutable(env);
  const versionOut = await run(bin, ['version', '--json'], env);
  if (versionOut.notFound || !versionOut.ok) return undefined;

  let version: string | undefined;
  try {
    const parsed = JSON.parse(versionOut.stdout) as { client?: { version?: unknown } };
    version = typeof parsed.client?.version === 'string' ? parsed.client.version : undefined;
  } catch {
    return undefined;
  }
  if (!version) return undefined;

  const base = { provider: 'docker-sbx' as const, version, backends: ['claude' as const, 'codex' as const] };
  if (!meetsMinimum(version)) return { ...base, state: 'unsupported-version' };

  const help = await run(bin, ['create', '--help'], env);
  const flagsPresent = help.ok && REQUIRED_CREATE_FLAGS.every((flag) => help.stdout.includes(flag));
  return { ...base, state: flagsPresent ? 'available' : 'unsupported-version' };
}

let cached: Promise<SandboxCapability | undefined> | undefined;

/**
 * `detectSandbox` memoized per process: `/health` is polled, and `sbx` is a ~0.5 s CLI.
 * Installing or upgrading `sbx` is picked up on the next cezar start.
 */
export function detectSandboxCached(): Promise<SandboxCapability | undefined> {
  cached ??= detectSandbox().catch(() => undefined);
  return cached;
}

/** Test seam: forget the memoized probe. */
export function resetSandboxDetectionCache(): void {
  cached = undefined;
}
