/**
 * Forge-neutral `prDiff` caps (spec 2026-08-10-forge-provider-adapters, Step 3.5, Decision D4):
 * both adapters bound their pull/merge-request diff the same way, so the numbers live in one
 * place rather than two copies that could drift. `forge/github.ts` keeps `GH_PR_DIFF_FILE_CAP` /
 * `GH_PR_PATCH_CAP` / `GH_PR_DIFF_JSON_CAP` exported as aliases of these — same values, so nothing
 * about GitHub's behaviour changes — because the diff already imports the old names.
 */

/** Max files a `prDiff` result carries — the 3rd page of a 100-per-page file listing. */
export const FORGE_PR_DIFF_FILE_CAP = 300;

/** Max bytes a single file's `patch` may occupy before it is dropped as `'too-large'`. */
export const FORGE_PR_PATCH_CAP = 512 * 1024;

/** Max bytes the whole `{files: […]}` payload may serialize to before trailing files are dropped. */
export const FORGE_PR_DIFF_JSON_CAP = 4 * 1024 * 1024;
