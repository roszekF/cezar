import { describe, expect, it } from 'vitest';
import { reclaimWorktrees } from './retention.ts';
import type { RunRecord } from './store.ts';

/** Reclaiming a sandboxed run's worktree removes its sandbox too (spec 2026-09-22-docker-sandboxes, Q2). */
describe('reclaimWorktrees — sandboxed runs', () => {
  const finished = (id: string, finishedAt: string, sandbox?: RunRecord['sandbox']): RunRecord =>
    ({ id, status: 'done', createdAt: finishedAt, finishedAt, worktreePath: `/nonexistent/wt/${id}`, sandbox, steps: [] }) as unknown as RunRecord;

  it('removes the sandbox of a reclaimed worktree and stamps removedAt; leaves the kept one alone', async () => {
    const runs = [
      finished('new', '2026-09-22T02:00:00.000Z', { provider: 'docker-sbx', name: 'cez-new' }),
      finished('old', '2026-09-22T01:00:00.000Z', { provider: 'docker-sbx', name: 'cez-old' }),
      finished('plain', '2026-09-21T00:00:00.000Z'),
    ];
    const patches: Array<[string, unknown]> = [];
    const removedSandboxes: string[] = [];
    const reclaimed = await reclaimWorktrees(
      '/nonexistent',
      { listRuns: () => runs, updateRun: (id, patch) => patches.push([id, patch]) },
      1,
      {
        now: () => 'T',
        remove: async () => undefined,
        removeSandbox: async (run) => removedSandboxes.push(run.sandbox?.name ?? '?'),
      },
    );
    expect(reclaimed).toEqual(['old', 'plain']);
    expect(removedSandboxes).toEqual(['cez-old']);
    expect(patches).toContainEqual(['old', { sandbox: { provider: 'docker-sbx', name: 'cez-old', removedAt: 'T' } }]);
    expect(patches.some(([id, patch]) => id === 'plain' && 'sandbox' in (patch as object))).toBe(false);
  });
});
