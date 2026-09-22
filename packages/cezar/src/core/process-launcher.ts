import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * The one seam between a run's processes and `child_process` (spec
 * 2026-09-22-docker-sandboxes). Agent runners and workflow check steps spawn
 * through a launcher instead of calling `spawn` directly, so a run can later be
 * moved into a sandbox by swapping the launcher, not the runner. The runners'
 * wire protocols (Claude stream-json, Codex app-server JSON-RPC) ride on the
 * returned child's stdio unchanged.
 *
 * `hostLauncher` is today's behavior: a plain child process on the host.
 */
export interface LaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProcessLauncher {
  readonly kind: 'host' | 'sandbox';
  spawn(bin: string, args: readonly string[], opts: LaunchOptions): ChildProcessWithoutNullStreams;
}

export const hostLauncher: ProcessLauncher = {
  kind: 'host',
  spawn: (bin, args, opts) => nodeSpawn(bin, [...args], { cwd: opts.cwd, env: opts.env }),
};
