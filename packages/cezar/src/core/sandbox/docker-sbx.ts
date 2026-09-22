import { execFile, spawn } from 'node:child_process';
import type { SandboxCapability } from '@open-mercato/cezar-contract';
import type { ProcessLauncher } from '../process-launcher.ts';

/**
 * Docker Sandboxes (`sbx`) — the only module that runs the `sbx` CLI (spec
 * 2026-09-22-docker-sandboxes): detection, sandbox lifecycle, and the launcher that runs a
 * process inside a sandbox.
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

// ---- lifecycle ---------------------------------------------------------------------------

export type SandboxAgent = 'claude' | 'codex';

/** Unprivileged agent templates — no inner dockerd, no 10 GB image store (spec § Sandbox creation). */
const TEMPLATES: Record<SandboxAgent, string> = {
  claude: 'docker.io/docker/sandbox-templates:claude-code',
  codex: 'docker.io/docker/sandbox-templates:codex',
};

const CREATE_TIMEOUT_MS = 10 * 60_000; // first create pulls the template image
const CONTROL_TIMEOUT_MS = 60_000;

export function sandboxNameFor(runId: string): string {
  return `cez-${runId}`;
}

/** A name cezar created: `cez-<uuid>`. Anything else is never touched by reconcile. */
export function isCezarSandboxName(name: string): string | undefined {
  return /^cez-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(name)?.[1];
}

interface SbxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run a control command. stdin is closed so an expired sign-in fails instead of prompting (docker/sbx-releases#406). */
function runSbx(args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<SbxResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveSbxExecutable(env), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

export interface SandboxInfo {
  name: string;
  status?: string;
  workspaces: string[];
}

/** `sbx ls --json`, tolerating the "Starting sandboxd daemon..." banner printed before the JSON (#201). */
export async function listSandboxes(env: NodeJS.ProcessEnv = process.env): Promise<SandboxInfo[] | undefined> {
  const out = await runSbx(['ls', '--json'], CONTROL_TIMEOUT_MS, env);
  if (!out.ok) return undefined;
  const start = out.stdout.indexOf('{');
  if (start === -1) return undefined;
  try {
    const parsed = JSON.parse(out.stdout.slice(start)) as { sandboxes?: Array<Partial<SandboxInfo>> };
    return (parsed.sandboxes ?? []).flatMap((s) =>
      typeof s.name === 'string'
        ? [{ name: s.name, status: s.status, workspaces: Array.isArray(s.workspaces) ? s.workspaces.map(String) : [] }]
        : [],
    );
  } catch {
    return undefined;
  }
}

export interface SandboxSpec {
  name: string;
  agent: SandboxAgent;
  /** Workspaces in `sbx create` order; the first is primary. `path:ro` for read-only. */
  workspaces: string[];
  memoryMb?: number;
}

/**
 * Make sure the named sandbox exists with this primary workspace. Idempotent: a sandbox a crash
 * left behind mid-create is reused when its primary workspace matches, and replaced otherwise.
 * `created: true` means a fresh VM — any agent session state from before is gone.
 */
export async function ensureSandbox(
  spec: SandboxSpec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ created: boolean } | { error: string }> {
  const existing = await listSandboxes(env);
  if (!existing) return { error: 'could not list sandboxes — is Docker Sandboxes signed in? Run `sbx login`' };
  const found = existing.find((s) => s.name === spec.name);
  if (found && found.workspaces[0] === spec.workspaces[0]) return { created: false };
  if (found) await removeSandbox(spec.name, env);
  const args = ['create', '--quiet', '--name', spec.name, '--pull', 'missing', '--skills', 'off', '--template', TEMPLATES[spec.agent]];
  if (spec.memoryMb && spec.memoryMb >= 512) args.push('--memory', `${Math.floor(spec.memoryMb)}m`);
  args.push(spec.agent, ...spec.workspaces);
  const out = await runSbx(args, CREATE_TIMEOUT_MS, env);
  if (!out.ok) return { error: `sbx create failed: ${(out.stderr || out.stdout).trim() || 'no output'}` };
  return { created: true };
}

/** Stop a sandbox, keeping its state for a later Continue. Best-effort. */
export async function stopSandbox(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await runSbx(['stop', name], CONTROL_TIMEOUT_MS, env)).ok;
}

/** Remove a sandbox and its state. Best-effort. */
export async function removeSandbox(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await runSbx(['rm', '--force', name], CONTROL_TIMEOUT_MS, env)).ok;
}

/**
 * A launcher that runs each process inside the named sandbox through `sbx exec -i`. Only the
 * `forward` env names cross into the VM, passed as bare `-e NAME` so values never appear in the
 * host's process table (`sbx` reads them from its own env — verified against sbx 0.45). The
 * process's stdio is the `sbx exec` client's, byte for byte (spike check a), and so is its exit
 * code (check b). Killing the client does NOT stop the inner process (check c): callers stop
 * the sandbox when a run ends.
 */
export function sandboxLauncher(
  name: string,
  forward: readonly string[],
  opts: { bin?: string; env?: NodeJS.ProcessEnv } = {},
): ProcessLauncher {
  const env = opts.env ?? process.env;
  return {
    kind: 'sandbox',
    // `bin` replaces the binary the caller resolved: a runner resolves a HOST path
    // (`CEZ_CLAUDE_BIN`), and the VM has its own agent on PATH.
    spawn: (requestedBin, args, launch) => {
      const bin = opts.bin ?? requestedBin;
      const passed = forward.filter((key) => launch.env[key] !== undefined);
      const picked = Object.fromEntries(passed.map((key) => [key, launch.env[key] as string]));
      const argv = ['exec', '-i', '-w', launch.cwd, ...passed.flatMap((key) => ['-e', key]), name, bin, ...args];
      return spawn(resolveSbxExecutable(env), argv, { env: { ...env, ...picked } });
    },
  };
}
