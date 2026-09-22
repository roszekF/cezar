import { execFile } from 'node:child_process';
import type { SandboxCapability } from '@open-mercato/cezar-contract';

/**
 * Which runs may be sandboxed (spec 2026-09-22-docker-sandboxes, § Validation). Pure, so the
 * route, the composer and tests share one answer. Each refusal names what to change.
 */
export interface SandboxRunRequest {
  capability: SandboxCapability | undefined;
  /** Every backend an agent step of the workflow resolves to. */
  backends: readonly string[];
  /** The composer's worktree toggle; `false` = run in the main checkout. */
  worktree?: boolean;
  /** An explicit composer account override. */
  agentProfile?: string;
  dispatch: boolean;
  isGitRepo: boolean;
  /** `extensions.worktreeConfig` is on in the repo. */
  worktreeConfig: boolean;
}

export function sandboxRunRefusal(req: SandboxRunRequest): string | undefined {
  if (!req.capability) {
    return 'sandboxed runs need Docker Sandboxes: install `sbx` (https://docs.docker.com/ai/sandboxes/) and restart cezar — or CEZ_SANDBOX=0 has turned them off';
  }
  if (req.capability.state !== 'available') {
    return `this sbx (${req.capability.version ?? 'unknown version'}) is not supported — update Docker Sandboxes and restart cezar`;
  }
  if (!req.isGitRepo) return 'sandboxed runs need a git repository: the sandbox mounts the task worktree';
  if (req.worktree === false) {
    return 'sandboxed runs need a worktree — the sandbox mounts the task worktree, never the main checkout';
  }
  const unsupported = req.backends.filter((b) => !(req.capability?.backends as readonly string[]).includes(b));
  if (unsupported.length) {
    return `sandboxed runs support Claude and Codex only (this workflow uses ${[...new Set(unsupported)].join(', ')})`;
  }
  if (new Set(req.backends).size > 1) {
    return 'a sandboxed run uses one agent per sandbox — this workflow mixes Claude and Codex steps';
  }
  if (req.agentProfile !== undefined) {
    return 'sandboxed runs use the sandbox login, not a cezar agent account — clear the account override';
  }
  if (req.dispatch) return 'sandboxed runs cannot dispatch tasks: the sandbox cannot reach the cockpit';
  if (req.worktreeConfig) {
    return 'sandboxed runs are refused while extensions.worktreeConfig is on: a per-worktree git config would be writable from the sandbox';
  }
  return undefined;
}

/** `git config --bool extensions.worktreeConfig` in the repo; any failure reads as off. */
export function worktreeConfigEnabled(repoRoot: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['config', '--bool', '--get', 'extensions.worktreeConfig'], { cwd: repoRoot, encoding: 'utf8' }, (err, stdout) =>
      resolve(!err && stdout.trim() === 'true'),
    );
  });
}
