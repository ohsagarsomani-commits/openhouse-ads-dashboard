#!/usr/bin/env node
// Builds the password-locked page from the dashboard, its runtime and a data file.
//
//   node scripts/build.mjs --data data/snapshot.json --out out
//
// The password comes from PAGE_PASSWORD, or is asked for (hidden) when run in a terminal.
// Everything the dashboard shows, data and page code alike, is gzipped and encrypted with
// AES-256-GCM under a key made from the password with PBKDF2-SHA256 (600,000 rounds).
// Only the encrypted page is written to --out. --plain <file> also writes an unlocked copy
// for local testing: never publish that file.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import readline from 'node:readline';
import zlib, { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const ITERATIONS = 600000;

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dataPath = resolve(arg('data', join(ROOT, 'data', 'snapshot.json')));
const outDir = resolve(arg('out', join(ROOT, 'out')));
const plainPath = arg('plain', null);

// ---- Lists kept with the page: campaign names and ticket prices ----
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
};

// ---- The page, with the few lines that differ in the shared copy ----
const PATCHES = [
  ['<meta name="dash-one-writer">', ''],
  [
    "const todayInIndia = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());",
    // Every period ends on the day the numbers were taken.
    'const todayInIndia = () => dash.today();',
  ],
  ["'Refreshes on its own every 2 hours'", 'dash.updatedText()'],
  [
    "'Select Preview on a card to see that ad the way people see it on Instagram.'",
    "'Each card shows the ad’s text as it runs on Meta. Open in Ads Manager needs access to Openhouse’s ad accounts.'",
  ],
];
let page = readFileSync(join(SITE, 'dashboard.html'), 'utf8');
// Where a table can't be filled, say why instead of "Failed to load".
PATCHES.push(["if (d.status === 'error') { el.textContent = 'Failed to load'; return; }", "if (d.status === 'error') { el.textContent = d.error || 'Failed to load'; return; }", 'all']);
for (const [from, to, all] of PATCHES) {
  if (!page.includes(from)) throw new Error('The dashboard page changed: could not find ' + JSON.stringify(from.slice(0, 60)));
  page = all ? page.split(from).join(to) : page.replace(from, to);
}

const data = JSON.parse(readFileSync(dataPath, 'utf8'));
for (const key of ['today', 'generated_at', 'campaigns', 'totals', 'coverage']) {
  if (!(key in data)) throw new Error('The data file has no ' + key + ': ' + dataPath);
}
data.lists = {
  campaign_names: parseCsv(readFileSync(join(SITE, 'lists', 'campaign-names.csv'), 'utf8')),
  ticket_prices: parseCsv(readFileSync(join(SITE, 'lists', 'ticket-prices.csv'), 'utf8')),
};
const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const inner = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Openhouse Meta Ads</title>
<style>${readFileSync(join(SITE, 'runtime.css'), 'utf8')}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
</head><body><main class="oh-page">
<script>window.__OH_DATA__=${json};</script>
<script>${readFileSync(join(SITE, 'runtime.js'), 'utf8')}</script>
${page}
<p class="oh-copy-foot">Shared copy of the Openhouse Meta Ads dashboard. It shows the numbers Meta reported at the time above and refreshes every 2 hours. <button class="oh-link" type="button" id="oh-forget">Lock and forget this device</button></p>
<script>
document.getElementById('oh-forget').addEventListener('click', () => {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('oh-dash-key-')) localStorage.removeItem(k); } catch (e) {}
  location.reload();
});
dash.start();
</script>
</main></body></html>`;

if (plainPath) {
  mkdirSync(dirname(resolve(plainPath)), { recursive: true });
  writeFileSync(resolve(plainPath), inner);
  console.log('Unlocked test copy (do not publish): ' + resolve(plainPath));
}

// ---- Password ----
const askHidden = (question) => new Promise((done) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(question); };
  rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); done(answer); });
});
let password = process.env.PAGE_PASSWORD || '';
if (!password) {
  if (!process.stdin.isTTY) throw new Error('Set PAGE_PASSWORD, or run this in a terminal to type the password.');
  password = await askHidden('Page password: ');
  const again = await askHidden('Same password again: ');
  if (password !== again) throw new Error('The two passwords differ. Nothing was written.');
}
if (password.length < 10) throw new Error('Use a password of at least 10 characters.');

// The salt stays the same between builds, so a device that remembered the key keeps opening new versions.
const saltFile = join(SITE, 'salt.txt');
if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(16).toString('base64') + '\n');
const salt = Buffer.from(readFileSync(saltFile, 'utf8').trim(), 'base64');

const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const packed = Buffer.concat([cipher.update(gzipSync(Buffer.from(inner, 'utf8'), { level: zlib.constants.Z_BEST_COMPRESSION })), cipher.final(), cipher.getAuthTag()]);

const lock = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Openhouse Meta Ads</title>
<style>
:root { color-scheme: light dark; --bg: #faf9f6; --panel: #ffffff; --fg: #1f1e1b; --muted: #6b6860; --line: #dedbd2; --bad: #b42318; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1b19; --panel: #262522; --fg: #eceae4; --muted: #a29f96; --line: #3a3833; --bad: #f07a6e; } }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
main { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
form { width: min(380px, 100%); display: flex; flex-direction: column; gap: 10px; padding: 28px 24px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
h1 { margin: 0 0 4px; font: 400 26px/1.2 ui-serif, "Iowan Old Style", Georgia, serif; }
p { margin: 0; color: var(--muted); }
label { font-size: 13px; color: var(--muted); }
input[type=password] { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; width: 100%; }
input[type=password]:focus-visible, button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.rem { display: flex; align-items: center; gap: 8px; color: var(--fg); }
button { font: inherit; font-weight: 600; color: var(--bg); background: var(--fg); border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; }
button[disabled] { opacity: .6; cursor: default; }
#msg { min-height: 1.5em; font-size: 13px; }
#msg.bad { color: var(--bad); }
</style></head><body><main>
<form id="lock" autocomplete="on">
  <h1>Openhouse Meta Ads</h1>
  <p>Enter the password to open the dashboard.</p>
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
  <label class="rem"><input id="rem" type="checkbox" checked> Remember on this device</label>
  <button id="go" type="submit">Open</button>
  <p id="msg" role="status" aria-live="polite"></p>
</form>
</main>
<script>
const LOCKED = ${JSON.stringify({ salt: salt.toString('base64'), iterations: ITERATIONS, iv: iv.toString('base64'), data: packed.toString('base64') })};
const KEY_NAME = 'oh-dash-key-' + LOCKED.salt;
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const say = (text, bad) => { const m = document.getElementById('msg'); m.textContent = text; m.className = bad ? 'bad' : ''; };
async function unlock(key, remember) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(LOCKED.iv) }, key, bytes(LOCKED.data));
  if (remember) {
    try { localStorage.setItem(KEY_NAME, btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', key))))); } catch (e) {}
  }
  const html = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  document.open();
  document.write(html);
  document.close();
}
async function keyFrom(password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: bytes(LOCKED.salt), iterations: LOCKED.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}
(async () => {
  let saved = null;
  try { saved = localStorage.getItem(KEY_NAME); } catch (e) {}
  if (!saved) return;
  say('Opening…');
  try {
    await unlock(await crypto.subtle.importKey('raw', bytes(saved), 'AES-GCM', false, ['decrypt']));
  } catch (e) {
    try { localStorage.removeItem(KEY_NAME); } catch (e2) {}
    say('');
  }
})();
document.getElementById('lock').addEventListener('submit', async (event) => {
  event.preventDefault();
  const go = document.getElementById('go');
  go.disabled = true;
  say('Opening…');
  try {
    await unlock(await keyFrom(document.getElementById('pw').value), document.getElementById('rem').checked);
  } catch (e) {
    go.disabled = false;
    say(e && e.name === 'OperationError' ? 'That password didn’t work. Try again.' : 'This browser couldn’t open the dashboard. Try a recent Chrome, Safari or Edge.', true);
    document.getElementById('pw').select();
  }
});
</script>
</body></html>`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), lock);
writeFileSync(join(outDir, '.nojekyll'), '');
writeFileSync(join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log(`Locked page: ${join(outDir, 'index.html')} (${Math.round(lock.length / 1024)} KB; dashboard ${Math.round(inner.length / 1024)} KB before compression)`);
