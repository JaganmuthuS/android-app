// In-app updates from GitHub releases (tags "mac-vX.Y.Z" with a zipped JARVIS.app attached).
import * as fs from 'fs';
import * as path from 'path';
import type { UpdateInfo, UpdateState } from '../shared/types';

export const UPDATE_REPO = { owner: 'JaganmuthuS', repo: 'android-app' };

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The download that fits this Mac: Apple silicon gets the smaller build, Intel the universal one. */
export function pickAsset(assets: { id: number; name: string; size: number }[], arch: string) {
  const zips = assets.filter((a) => a.name.endsWith('.zip'));
  const apple = zips.find((a) => /apple-silicon|arm64/i.test(a.name));
  const universal = zips.find((a) => !/apple-silicon|arm64/i.test(a.name));
  return arch === 'arm64' ? apple ?? universal : universal;
}

interface ReleaseJson { tag_name: string; name: string; body: string; draft: boolean; prerelease: boolean; html_url: string; assets: { id: number; name: string; size: number }[] }

export class Updater {
  constructor(private opts: {
    current: string;
    arch: string;
    token: () => string | null;
    downloadDir: string;
    apiBase?: string;
  }) {}

  private headers(accept = 'application/vnd.github+json'): Record<string, string> {
    const h: Record<string, string> = { Accept: accept, 'User-Agent': 'JARVIS-updater', 'X-GitHub-Api-Version': '2022-11-28' };
    const t = this.opts.token();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }
  private get api() { return (this.opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, ''); }

  async check(): Promise<UpdateState> {
    const url = `${this.api}/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases?per_page=30`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    } catch {
      return { state: 'error', error: 'JARVIS could not reach GitHub. Check your internet connection.' };
    }
    if (res.status === 404) {
      return {
        state: 'error', needsToken: true,
        error: this.opts.token()
          ? 'GitHub did not show the releases to this token. Give it read access to the repository\'s contents.'
          : 'JARVIS can\'t see updates because the GitHub repository is private. Make the repository public, or add a GitHub token below.',
      };
    }
    if (res.status === 401) return { state: 'error', needsToken: true, error: 'GitHub rejected the token. Create a new one and paste it below.' };
    if (res.status === 403 || res.status === 429) return { state: 'error', error: 'GitHub is limiting requests right now. Try again in an hour.' };
    if (!res.ok) return { state: 'error', error: `GitHub answered ${res.status}. Try again later.` };
    const releases = (await res.json()) as ReleaseJson[];
    let best: { r: ReleaseJson; version: string } | null = null;
    for (const r of releases) {
      const m = r.tag_name.match(/^mac-v(\d+\.\d+(?:\.\d+)?)$/);
      if (!m || r.draft || r.prerelease) continue;
      if (!best || compareVersions(m[1], best.version) > 0) best = { r, version: m[1] };
    }
    if (!best || compareVersions(best.version, this.opts.current) <= 0) return { state: 'none', checkedAt: Date.now() };
    const asset = pickAsset(best.r.assets, this.opts.arch);
    if (!asset) return { state: 'error', error: `Version ${best.version} has no app download for this Mac yet.` };
    const info: UpdateInfo = {
      version: best.version, tag: best.r.tag_name, notes: (best.r.body ?? '').trim(), url: best.r.html_url,
      assetId: asset.id, assetName: asset.name, size: asset.size,
    };
    return { state: 'available', info, checkedAt: Date.now() };
  }

  /** Download the release zip, reporting progress (0..1). Returns the file path. */
  async download(info: UpdateInfo, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
    fs.mkdirSync(this.opts.downloadDir, { recursive: true });
    const file = path.join(this.opts.downloadDir, `JARVIS-${info.version}.zip`);
    const res = await fetch(`${this.api}/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/assets/${info.assetId}`, {
      headers: this.headers('application/octet-stream'), redirect: 'follow', signal,
    });
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}). Try again.`);
    const total = Number(res.headers.get('content-length')) || info.size || 0;
    const out = fs.createWriteStream(file);
    const reader = res.body.getReader();
    let got = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        if (total) onProgress(Math.min(1, got / total));
      }
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    if (info.size && got !== info.size) {
      fs.rmSync(file, { force: true });
      throw new Error('The download was incomplete. Try again.');
    }
    onProgress(1);
    return file;
  }
}

/**
 * The shell script that swaps the app once JARVIS has quit. It waits for the old process,
 * moves the old app aside, copies the new one in, and puts the old one back if anything fails.
 * Paths arrive as arguments ($1..$4), never pasted into the script text.
 */
export const SWAP_SCRIPT = `#!/bin/bash
APP="$1"; NEW="$2"; PID="$3"; TMP="$4"
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
rm -rf "$APP.previous"
if mv "$APP" "$APP.previous"; then
  if /usr/bin/ditto "$NEW" "$APP"; then
    /usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
    rm -rf "$APP.previous"
  else
    rm -rf "$APP"
    mv "$APP.previous" "$APP"
  fi
fi
/usr/bin/open "$APP"
rm -rf "$TMP"
`;

/** Read CFBundleShortVersionString from an unpacked app, to check we downloaded what we expected. */
export function bundleVersion(appPath: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
  } catch { return null; }
}
