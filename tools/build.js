#!/usr/bin/env node
/*
 * Builds the Revivv site from src/ into plain HTML pages at the top of this folder.
 *
 *   node tools/build.js      build every page, bump the service worker, check links
 *
 * Never edit index.html / portal.html / staff.html at the top of the folder — the
 * build overwrites them. Edit src/pages/*.html, src/partials/*.html, src/layout.html,
 * assets/css/site.css or assets/js/*.js instead.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE_NAME = 'Revivv Vehicle Detailing';
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const PAGES = path.join(SRC, 'pages');
const PARTIALS = path.join(SRC, 'partials');

function includes(html, seen = []) {
  return html.replace(/<!--\s*include\s+([\w-]+)\s*-->/g, (m, name) => {
    if (seen.includes(name)) throw new Error('include loop: ' + seen.concat(name).join(' > '));
    const f = path.join(PARTIALS, name + '.html');
    if (!fs.existsSync(f)) throw new Error('missing partial: src/partials/' + name + '.html');
    return includes(fs.readFileSync(f, 'utf8'), seen.concat(name));
  });
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

const layout = fs.readFileSync(path.join(SRC, 'layout.html'), 'utf8');

// Cache-busting version: a short hash of the CSS + every JS file.
const jsDir = path.join(ROOT, 'assets/js');
const jsFiles = fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort() : [];
const h = crypto.createHash('md5');
h.update(fs.readFileSync(path.join(ROOT, 'assets/css/site.css')));
jsFiles.forEach(f => h.update(fs.readFileSync(path.join(jsDir, f))));
const version = h.digest('hex').slice(0, 8);

const built = [];
for (const rel of fs.readdirSync(PAGES).filter(f => f.endsWith('.html'))) {
  const raw = fs.readFileSync(path.join(PAGES, rel), 'utf8');
  const m = raw.match(/^\s*<!--meta\s*([\s\S]*?)-->/);
  if (!m) throw new Error(rel + ': missing <!--meta {...} --> header');
  let meta;
  try { meta = JSON.parse(m[1]); } catch (e) { throw new Error(rel + ': meta is not valid JSON (' + e.message + ')'); }

  const body = includes(raw.slice(m[0].length));
  const isApp = meta.chrome === 'app';   // app pages (e.g. Staff) bring their own header, no marketing nav/footer
  const scripts = (meta.scripts || []).map(s => `<script src="${s}?v=${version}"></script>`).join('\n');
  const styles = (meta.styles || []).map(s => `<link rel="stylesheet" href="${s}?v=${version}">`).join('\n');
  const preload = (meta.preload || []).map(p => `<link rel="preload" as="image" href="${p}">`).join('\n');
  const nav = isApp ? '' : includes('<!--include nav-->');
  const footer = isApp ? '' : includes('<!--include footer-->');
  const installbar = isApp ? '' : includes('<!--include install-bar-->');

  let html = includes(layout).replace('{{content}}', () => body);
  html = html
    .replace(/\{\{nav\}\}/g, () => nav)
    .replace(/\{\{footer\}\}/g, () => footer)
    .replace(/\{\{installbar\}\}/g, () => installbar)
    .replace(/\{\{styles\}\}/g, () => styles)
    .replace(/\{\{title\}\}/g, esc(meta.title ? `${meta.title} — ${SITE_NAME}` : `${SITE_NAME} — Barbados`))
    .replace(/\{\{description\}\}/g, esc(meta.description || ''))
    .replace(/\{\{bodyClass\}\}/g, meta.bodyClass || '')
    .replace(/\{\{active:(\w+)\}\}/g, (x, key) => (meta.nav === key ? ' is-active' : ''))
    .replace(/\{\{scripts\}\}/g, () => scripts)
    .replace(/\{\{preload\}\}/g, () => preload)
    .replace(/\{\{version\}\}/g, version);

  const left = html.match(/\{\{[^}]+\}\}/g);
  if (left) throw new Error(rel + ': unresolved ' + [...new Set(left)].join(', '));
  fs.writeFileSync(path.join(ROOT, rel), html);
  built.push(rel);
}

// Update the service worker: new VERSION (busts the cache) + a SHELL list of files
// that actually exist (addAll is atomic — a missing file would break install).
const swPath = path.join(ROOT, 'sw.js');
if (fs.existsSync(swPath)) {
  const assets = [];
  ['assets/css', 'assets/js'].forEach(d => {
    const dd = path.join(ROOT, d);
    if (fs.existsSync(dd)) fs.readdirSync(dd).forEach(f => { if (/\.(css|js)$/.test(f)) assets.push('./' + d + '/' + f); });
  });
  const imgs = ['logo.png', 'favicon.png', 'app-192.png', 'app-512.png', 'apple-touch-icon.png']
    .filter(f => fs.existsSync(path.join(ROOT, 'images', f))).map(f => './images/' + f);
  const shell = ['./', ...built.map(p => './' + p), './manifest.json', ...assets, ...imgs];
  let sw = fs.readFileSync(swPath, 'utf8');
  sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = 'revivv-${version}';`);
  sw = sw.replace(/const SHELL = \[[\s\S]*?\];/, 'const SHELL = [\n  ' + shell.map(s => `'${s}'`).join(',\n  ') + '\n];');
  fs.writeFileSync(swPath, sw);
}

console.log(`built ${built.length} page(s): ${built.join(', ')}  [v${version}]`);

// Checks: internal links/images exist; list any [PLACEHOLDERS] still waiting.
const problems = [];
const placeholders = new Map();
for (const rel of built) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(x => x[1]));
  for (const [, attr, url] of html.matchAll(/\s(href|src)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|tel:|data:|#)/.test(url)) {
      if (url.startsWith('#') && url.length > 1 && !ids.has(url.slice(1))) problems.push(`${rel}: ${attr} ${url} (no such id on the page)`);
      continue;
    }
    const [file, hash] = url.split('#');
    const target = path.join(ROOT, file.split('?')[0]);
    if (!fs.existsSync(target)) { problems.push(`${rel}: ${attr} ${url} (file missing)`); continue; }
    if (hash && file.endsWith('.html')) {
      const other = fs.readFileSync(target, 'utf8');
      if (!new RegExp(`\\sid="${hash}"`).test(other)) problems.push(`${rel}: ${url} (no #${hash} in ${file})`);
    }
  }
  for (const [ph] of html.matchAll(/\[[A-Z][A-Z0-9 .,'&/-]+\]/g)) placeholders.set(ph, (placeholders.get(ph) || 0) + 1);
}
if (problems.length) { console.log(`\n${problems.length} problem(s):\n  ` + problems.join('\n  ')); process.exitCode = 1; }
else console.log('links and images: all OK');
if (placeholders.size) console.log('\nplaceholders still to fill: ' + [...placeholders.keys()].sort().join(', '));
