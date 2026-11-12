import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import type { GithubAssetResponse } from '@open-mercato/cezar-contract';
import type { ParsedRemote } from '../../git-remotes.ts';
import { runCli } from './cli.ts';

export const GITLAB_ASSET_MAX_BYTES = 5 * 1024 * 1024;
let active = 0;

interface Connection { origin: string; token: string; ca?: Buffer }
interface Asset { status: number; mime: string; bytes: Buffer }

/** Only the current project's upload is translated to an API path; never fetch a supplied URL. */
export function gitlabUploadPath(source: string, parsed: ParsedRemote, webUrl?: string | null): string | null {
  let path = source;
  if (!source.startsWith('/uploads/')) {
    try {
      const url = new URL(source);
      const project = new URL(webUrl ?? `${parsed.origin}/${parsed.path}`);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.origin !== project.origin || !url.pathname.startsWith(`${project.pathname.replace(/\/$/, '')}/uploads/`)) return null;
      path = url.pathname.slice(project.pathname.replace(/\/$/, '').length);
    } catch { return null; }
  }
  const match = /^\/uploads\/([a-f\d]{32})\/([^/?#]+)$/i.exec(path);
  if (!match) return null;
  let filename: string;
  try { filename = decodeURIComponent(match[2]!); } catch { return null; }
  if (!filename || filename === '.' || filename === '..' || /[\\/\x00-\x1f\x7f]/.test(filename)) return null;
  return `${match[1]}/${encodeURIComponent(filename)}`;
}

async function connection(root: string, host: string): Promise<Connection> {
  // Repo-local glab settings must not redirect a global credential to a different API host.
  const setting = (key: string) => runCli('glab', root, ['config', 'get', key, '--host', host, '--global'],
    { timeoutMs: 5_000, maxBuffer: 16 * 1024 }).then((s) => s.trim());
  const [apiHost, protocol, token, caFile] = await Promise.all([
    setting('api_host'), setting('api_protocol'), setting('token'), setting('ca_cert'),
  ]);
  if (protocol && protocol !== 'https') throw new Error('HTTPS required');
  const origin = new URL(`https://${apiHost || host}`);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !token) throw new Error('Invalid GitLab connection');
  return { origin: origin.origin, token, ...(caFile ? { ca: await readFile(caFile) } : {}) };
}

function download(url: URL, config: Connection): Promise<Asset> {
  return new Promise((resolve, reject) => {
    // The uploads API is project-scoped (GitLab 17.4+). Redirects are refused so credentials
    // can never follow an object-storage or attacker-controlled Location header.
    const req = request(url, {
      headers: { 'PRIVATE-TOKEN': config.token, Accept: 'image/*' },
      ...(config.ca ? { ca: config.ca } : {}), rejectUnauthorized: true,
      signal: AbortSignal.timeout(10_000),
    }, (res) => {
      if (res.statusCode !== 200 || Number(res.headers['content-length']) > GITLAB_ASSET_MAX_BYTES) {
        res.destroy(); resolve({ status: res.statusCode ?? 0, mime: '', bytes: Buffer.alloc(0) }); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > GITLAB_ASSET_MAX_BYTES) { res.destroy(new Error('Asset exceeds limit')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: 200, mime: (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(), bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

function rasterType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(bytes.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}

export async function loadGitlabAsset(root: string, source: string, parsed: ParsedRemote, webUrl?: string | null, deps: {
  connection?: typeof connection;
  download?: typeof download;
} = {}): Promise<GithubAssetResponse> {
  const unavailable = { available: false as const };
  const upload = gitlabUploadPath(source, parsed, webUrl);
  if (!upload || !parsed.path || process.env.CEZ_DRY_RUN === '1') return unavailable;
  if (active >= 4) return { available: false, retryable: true };
  active++;
  try {
    const config = await (deps.connection ?? connection)(root, parsed.host);
    const url = new URL(`/api/v4/projects/${encodeURIComponent(parsed.path)}/uploads/${upload}`, config.origin);
    if (url.protocol !== 'https:' || url.username || url.password) return unavailable;
    const asset = await (deps.download ?? download)(url, config);
    const mime = rasterType(asset.bytes);
    // GitLab's uploads API serves stored raster files as application/octet-stream.
    // Signature sniffing supplies the image MIME; executable and mismatched types still fail.
    if (asset.status !== 200 || asset.bytes.length > GITLAB_ASSET_MAX_BYTES || !mime ||
      (asset.mime !== mime && asset.mime !== 'application/octet-stream')) return unavailable;
    return { available: true, dataUrl: `data:${mime};base64,${asset.bytes.toString('base64')}` };
  } catch {
    // CLI and transport errors may contain tokens, upload secrets or private paths.
    return unavailable;
  } finally { active--; }
}
