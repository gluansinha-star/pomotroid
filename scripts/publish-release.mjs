/**
 * Publish the Windows release to the fork and attach the installers.
 *
 * Done in Node rather than PowerShell: ConvertTo-Json was serialising the
 * FileInfo object instead of the release-notes string, and there is no way to
 * express `body` as a plain string without fighting the pipeline.
 *
 * Usage: node scripts/publish-release.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const parent = join(root, '..');

const REPO = 'gluansinha-star/pomotroid';
const TAG = 'v1.7.1-fork.1';
const NOTES = join(parent, 'release-notes.md');
const BUNDLE = join(root, 'src-tauri', 'target', 'release', 'bundle');

// --- Credential: reuse whatever Git Credential Manager already stores --------
let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
if (!token) {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
  token = line ? line.slice('password='.length) : '';
}
if (!token) throw new Error('No GitHub token available');

const headers = {
  Authorization: `token ${token}`,
  'User-Agent': 'pomotroid-release',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}\n${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : null;
}

// --- Create the release ------------------------------------------------------
const body = readFileSync(NOTES, 'utf8');
console.log(`release notes: ${body.length} chars`);

let release;
try {
  release = await api(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      target_commitish: 'main',
      name: 'Pomotroid fork 1.7.1 — Incremental Focus + Better Stats',
      body,
      draft: false,
      prerelease: false,
    }),
  });
  console.log(`created: ${release.html_url}`);
} catch (err) {
  if (!String(err.message).includes('already_exists')) throw err;
  console.log('release already exists — reusing it');
  release = await api(`/repos/${REPO}/releases/tags/${TAG}`);
  // Replace the body so a re-run picks up edited notes.
  release = await api(`/repos/${REPO}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

// --- Collect assets ----------------------------------------------------------
const assets = [];
const nsis = join(BUNDLE, 'nsis', 'Pomotroid_1.7.1_x64-setup.exe');
if (existsSync(nsis)) assets.push(nsis);

const msiDir = join(BUNDLE, 'msi');
if (existsSync(msiDir)) {
  const msi = execFileSync('powershell', ['-NoProfile', '-Command', `Get-ChildItem '${msiDir}' -Filter *.msi | Select-Object -ExpandProperty FullName`], { encoding: 'utf8' })
    .trim();
  if (msi) assets.push(msi.split(/\r?\n/)[0]);
}

const zip = join(BUNDLE, 'portable', 'Pomotroid_1.7.1_x64-portable.zip');
assets.push(zip); // may not exist; handled below

// Build the portable zip from the release exe if it is missing.
if (!existsSync(zip)) {
  const exe = join(root, 'src-tauri', 'target', 'release', 'pomotroid.exe');
  if (existsSync(exe)) {
    const stage = join(BUNDLE, 'portable');
    execFileSync('powershell', ['-NoProfile', '-Command', `New-Item -ItemType Directory -Force -Path '${stage}' | Out-Null`]);
    console.log('building portable zip ...');
    execFileSync('tar', ['-a', '-c', '-f', zip, '-C', join(root, 'src-tauri', 'target', 'release'), 'pomotroid.exe'], { stdio: 'inherit' });
  }
}

// --- Upload -----------------------------------------------------------------
const existing = new Set((release.assets ?? []).map((a) => a.name));
const uploadBase = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets`;

for (const path of assets) {
  if (!existsSync(path)) {
    console.log(`skip (missing): ${path}`);
    continue;
  }
  const name = path.split(/[\\/]/).pop();
  if (existing.has(name)) {
    console.log(`skip (already uploaded): ${name}`);
    continue;
  }
  const sizeMb = (statSync(path).size / 1024 / 1024).toFixed(1);
  console.log(`uploading ${name} (${sizeMb} MB) ...`);
  const bytes = readFileSync(path);
  const res = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload failed for ${name}: ${res.status}\n${text.slice(0, 500)}`);
  console.log(`  -> ${JSON.parse(text).browser_download_url}`);
}

// --- Report -----------------------------------------------------------------
const final = await api(`/repos/${REPO}/releases/tags/${TAG}`);
console.log('\n=== release ===');
console.log(`name: ${final.name}`);
console.log(`tag:  ${final.tag_name}`);
console.log(`url:  ${final.html_url}`);
console.log(`body: ${final.body.length} chars`);
for (const a of final.assets) {
  console.log(`  ${a.name.padEnd(38)} ${(a.size / 1024 / 1024).toFixed(1)} MB`);
}
