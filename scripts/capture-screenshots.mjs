/**
 * Capture README screenshots from the running dev server using Edge's
 * DevTools Protocol.
 *
 * Takes full-page PNGs at 2x device scale so the text stays crisp on GitHub.
 *
 * Usage: node scripts/capture-screenshots.mjs
 * Requires the dev server to be running on http://localhost:1420.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, '.github', 'images');
mkdirSync(outDir, { recursive: true });

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!browser) throw new Error('No Chromium-based browser found');

const PORT = 9333;
// The browser profile MUST live outside the project tree: Edge keeps SQLite
// files open inside it, which makes Vite's file watcher crash with EBUSY.
const PROFILE = join(tmpdir(), `pomotroid-shots-${process.pid}`);
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const BASE = 'http://localhost:1420';

/** Pages to capture: [name, url, viewportWidth, viewportHeight]. */
const SHOTS = [
  ['better-stats-overview', `${BASE}/better-stats`, 1120, 900],
  ['incremental-focus-settings', `${BASE}/settings`, 760, 900],
];

const child = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false }
);

/** Wait until the DevTools endpoint answers. */
async function waitForEndpoint(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('DevTools endpoint never became available');
}

/** Minimal CDP client over the browser-level WebSocket. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}, useSession = true) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (useSession && this.sessionId) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }
}

async function connect() {
  const version = await waitForEndpoint();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new CDP(ws);
}

/** Create a fresh page target and attach a session to it. */
async function newPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }, false);
  const { sessionId } = await cdp.send(
    'Target.attachToTarget',
    { targetId, flatten: true },
    false
  );
  cdp.sessionId = sessionId;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return targetId;
}

/** Poll until the page has rendered real content. */
async function waitForText(cdp, needle, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    const text = result?.value ?? '';
    if (text.includes(needle)) return text;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for text: ${needle}`);
}

/** Measure the full scrollable page. */
async function pageMetrics(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const h = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight
      );
      const w = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
      return { h, w };
    })()`,
    returnByValue: true,
  });
  return result.value;
}

async function main() {
  const cdp = await connect();
  console.log('Connected to DevTools.');

  for (const [name, url, width, height] of SHOTS) {
    console.log(`\n--- ${name} ---`);
    const targetId = await newPage(cdp);

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });

    await cdp.send('Page.navigate', { url });
    await sleep(1200);

    // Wait for the page to actually finish rendering.
    if (name.startsWith('better-stats')) {
      await waitForText(cdp, 'Momentum');
      // Let the entry animations and chart transitions settle.
      await sleep(2500);
    } else {
      await waitForText(cdp, 'Incremental Focus');
      // Scroll the incremental block into view so it is clearly visible.
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const els = [...document.querySelectorAll('span,div')];
          const label = els.find(e => e.textContent?.trim() === 'Incremental Focus');
          if (label) label.scrollIntoView({ block: 'center' });
          return true;
        })()`,
        returnByValue: true,
      });
      await sleep(1200);
    }

    const { h, w } = await pageMetrics(cdp);
    console.log(`  content size: ${w}x${h} (viewport ${width}x${height})`);

    // Capture exactly the visible viewport (what a user would see).
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });

    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`  wrote ${file}`);

    await cdp.send('Target.closeTarget', { targetId }, false);
  }

  cdp.ws.close();
  child.kill();
  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message);
    child.kill();
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      rmSync(PROFILE, { recursive: true, force: true });
    }, 500);
  });
