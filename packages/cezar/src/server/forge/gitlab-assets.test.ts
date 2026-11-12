import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.ts';
vi.mock('./cli.ts', () => ({ runCli: vi.fn() }));
import { parseRemote } from '../../git-remotes.ts';
import { GITLAB_ASSET_MAX_BYTES, gitlabUploadPath, loadGitlabAsset } from './gitlab-assets.ts';

const parsed = parseRemote('ssh://git@api.gitlab.example.test:2222/group/sub/project.git')!;
const WEB = 'https://git.example.test:4443/group/sub/project';
const PATH = '/uploads/0123456789abcdef0123456789abcdef/screenshot.png';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const connection = vi.fn(async () => ({ origin: 'https://api.gitlab.example.test', token: 'private-token' }));
const download = vi.fn(async (_url: URL) => ({ status: 200, mime: 'image/png', bytes: PNG }));
afterEach(() => { vi.unstubAllEnvs(); connection.mockClear(); download.mockClear(); vi.mocked(runCli).mockReset(); });

describe('GitLab project uploads', () => {
  it.each([PATH, `${WEB}${PATH}`])('maps current project uploads to the scoped API: %s', async (source) => {
    expect(await loadGitlabAsset('/repo', source, parsed, WEB, { connection, download })).toEqual({ available: true, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(download.mock.calls[0]?.[0]?.href).toBe('https://api.gitlab.example.test/api/v4/projects/group%2Fsub%2Fproject/uploads/0123456789abcdef0123456789abcdef/screenshot.png');
  });
  it.each([
    'https://evil.test' + PATH, 'http://git.example.test:4443/group/sub/project' + PATH,
    'https://user:secret@git.example.test:4443/group/sub/project' + PATH,
    'https://git.example.test:4443/group/sub/other' + PATH, `${WEB}${PATH}?token=secret`, `${WEB}${PATH}#fragment`,
    PATH.replace('screenshot.png', '%2e%2e%2fsecret'), PATH.replace('screenshot.png', '%5csecret'),
    PATH.replace('screenshot.png', '%00'), PATH.replace('screenshot.png', '..'),
    PATH.replace('screenshot.png', '%zz'), '/uploads/no-secret/image.png', '//evil.test/image.png',
    '/api/v4/projects/another/uploads/123/a.png',
  ])('refuses invalid/cross-project paths before any credentials: %s', async (source) => {
    expect(gitlabUploadPath(source, parsed, WEB)).toBeNull();
    expect(await loadGitlabAsset('/repo', source, parsed, WEB, { connection, download })).toEqual({ available: false });
    expect(connection).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
  });
  it('sniffs the octet-stream response returned by the GitLab uploads API', async () => {
    expect((await loadGitlabAsset('/repo', PATH, parsed, WEB, { connection, download: async () => ({ status: 200, mime: 'application/octet-stream', bytes: PNG }) })).available).toBe(true);
  });
  it('reads only global per-host credentials and never repo-local glab settings', async () => {
    vi.mocked(runCli).mockImplementation(async (_bin, _root, args) => {
      return ({ api_host: 'api.gitlab.example.test', api_protocol: 'https', token: 'private-token', ca_cert: '' } as Record<string, string>)[args[2]!] ?? '';
    });
    expect((await loadGitlabAsset('/repo', PATH, parsed, WEB, { download })).available).toBe(true);
    expect(runCli).toHaveBeenCalledTimes(4);
    for (const [bin, root, args, options] of vi.mocked(runCli).mock.calls) {
      expect(bin).toBe('glab'); expect(root).toBe('/repo');
      expect(args.slice(3)).toEqual(['--host', 'api.gitlab.example.test', '--global']);
      expect(options).toEqual({ timeoutMs: 5_000, maxBuffer: 16 * 1024 });
    }
  });
  it('encodes a filename once for the API', () => {
    expect(gitlabUploadPath(PATH.replace('screenshot.png', 'my%20screen.png'), parsed, WEB)).toBe('0123456789abcdef0123456789abcdef/my%20screen.png');
  });
  it.each([
    { status: 302, mime: 'image/png', bytes: PNG },
    { status: 200, mime: 'image/jpeg', bytes: PNG },
    { status: 200, mime: 'image/png', bytes: Buffer.from('<svg onload="evil()"/>') },
    { status: 200, mime: 'image/png', bytes: Buffer.alloc(GITLAB_ASSET_MAX_BYTES + 1) },
  ])('rejects non-raster, mismatched, oversize and redirect responses', async (asset) => {
    expect(await loadGitlabAsset('/repo', PATH, parsed, WEB, { connection, download: async () => asset })).toEqual({ available: false });
  });
  it('contains private transport errors', async () => {
    expect(await loadGitlabAsset('/repo', PATH, parsed, WEB, { connection, download: async () => { throw new Error('private-token'); } })).toEqual({ available: false });
  });
  it('does not read credentials or make requests in dry run', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    expect(await loadGitlabAsset('/repo', PATH, parsed, WEB, { connection, download })).toEqual({ available: false });
    expect(connection).not.toHaveBeenCalled();
  });
  it('bounds concurrent loading and releases slots', async () => {
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    const wait = async () => { await pending; return { status: 200, mime: 'image/png', bytes: PNG }; };
    const jobs = Array.from({ length: 4 }, () => loadGitlabAsset('/repo', PATH, parsed, WEB, { connection, download: wait }));
    expect(await loadGitlabAsset('/repo', PATH, parsed, WEB, { connection, download })).toEqual({ available: false, retryable: true });
    release(); expect((await Promise.all(jobs)).every((r) => r.available)).toBe(true);
    expect((await loadGitlabAsset('/repo', PATH, parsed, WEB, { connection, download })).available).toBe(true);
  });
});
