import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SWAP_SCRIPT, Updater, compareVersions, pickAsset } from '../electron/updater';

let server: http.Server;
let base = '';
let mode: 'ok' | 'private' = 'ok';
let lastAuth: string | undefined;
const ZIP = Buffer.from('PK fake zip bytes for the test');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (mode === 'private' && !req.headers.authorization) { res.statusCode = 404; return res.end('{}'); }
    if (req.url?.startsWith('/repos/JaganmuthuS/android-app/releases?')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify([
        { tag_name: 'v1.0', draft: false, prerelease: false, assets: [] },                       // Android release: ignored
        { tag_name: 'mac-v0.4.1', draft: false, prerelease: false, body: 'Fixes', html_url: 'u', assets: [
          { id: 11, name: 'JARVIS-mac.zip', size: ZIP.length }, { id: 12, name: 'JARVIS-mac-apple-silicon.zip', size: ZIP.length }, { id: 13, name: 'JARVIS-mac.dmg', size: 5 }] },
        { tag_name: 'mac-v0.5.0', draft: true, prerelease: false, assets: [] },                 // drafts are ignored
        { tag_name: 'mac-v0.3.4', draft: false, prerelease: false, assets: [] },
      ]));
    }
    if (req.url === '/repos/JaganmuthuS/android-app/releases/assets/12') {
      res.setHeader('content-length', String(ZIP.length));
      return res.end(ZIP);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const make = (current: string, token: string | null = null) =>
  new Updater({ current, arch: 'arm64', token: () => token, downloadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')), apiBase: base });

describe('updater', () => {
  it('compares versions and picks the download for the chip', () => {
    expect(compareVersions('0.4.1', '0.4.0')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.4', '0.4.0')).toBe(0);
    const assets = [{ id: 1, name: 'JARVIS-mac.zip', size: 1 }, { id: 2, name: 'JARVIS-mac-apple-silicon.zip', size: 1 }];
    expect(pickAsset(assets, 'arm64')?.id).toBe(2);
    expect(pickAsset(assets, 'x64')?.id).toBe(1);
  });

  it('finds the newest published Mac release and ignores drafts and Android releases', async () => {
    mode = 'ok';
    const s = await make('0.4.0').check();
    expect(s.state).toBe('available');
    expect(s.info).toMatchObject({ version: '0.4.1', assetId: 12, assetName: 'JARVIS-mac-apple-silicon.zip', notes: 'Fixes' });
    expect((await make('0.4.1').check()).state).toBe('none');
  });

  it('downloads with progress', async () => {
    mode = 'ok';
    const u = make('0.4.0');
    const s = await u.check();
    const seen: number[] = [];
    const file = await u.download(s.info!, (p) => seen.push(p));
    expect(fs.readFileSync(file)).toEqual(ZIP);
    expect(seen.at(-1)).toBe(1);
  });

  it('explains a private repository and uses a token when given one', async () => {
    mode = 'private';
    const s = await make('0.4.0').check();
    expect(s).toMatchObject({ state: 'error', needsToken: true });
    expect(s.error).toMatch(/private/);
    const withToken = await make('0.4.0', 'github_pat_abc').check();
    expect(withToken.state).toBe('available');
    expect(lastAuth).toBe('Bearer github_pat_abc');
  });

  it('swaps the app with a rollback, taking paths only as arguments', () => {
    expect(SWAP_SCRIPT).toContain('APP="$1"; NEW="$2"; PID="$3"; TMP="$4"');
    expect(SWAP_SCRIPT).toContain('mv "$APP.previous" "$APP"');
    expect(SWAP_SCRIPT).toContain('/usr/bin/open "$APP"');
  });
});
