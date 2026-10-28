// The server prices bookings itself. Its starting price list (before the owners
// change anything in Settings) must match what the website's pages show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/settings.js';
import { REWARD_OFF } from '../src/rules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const KEYS = { 'The Express Exterior': 'exterior', 'All-Around Express': 'allround', 'The Express Interior': 'interior', 'Supreme Auto Valet': 'supreme' };

for (const file of ['assets/js/app.js', 'assets/js/portal.js']) {
  test(`package prices match ${file}`, () => {
    const js = read(file);
    for (const p of DEFAULTS.catalog.packages) {
      const key = KEYS[p.name];
      const m = js.match(new RegExp(`${key}\\s*:\\s*\\{\\s*label\\s*:\\s*"([^"]+)"\\s*,\\s*price\\s*:\\s*\\{\\s*car\\s*:\\s*(\\d+)\\s*,\\s*suv\\s*:\\s*(\\d+)\\s*,\\s*truck\\s*:\\s*(\\d+)\\s*\\}[^}]*?long\\s*:\\s*(true|false)`));
      assert.ok(m, `${key} not found in ${file}`);
      assert.equal(m[1], p.name);
      assert.deepEqual([+m[2], +m[3], +m[4]], [p.prices.Car, p.prices.SUV, p.prices.Truck]);
      assert.equal(m[5] === 'true', p.long);
    }
    assert.match(js, new RegExp(`const REWARD_OFF\\s*=\\s*${REWARD_OFF.toFixed(2)};`));
  });
}

for (const file of ['src/pages/quote.html', 'src/pages/portal.html']) {
  test(`add-on prices match ${file}`, () => {
    const html = read(file).replace(/&amp;/g, '&');
    const found = Object.fromEntries([...html.matchAll(/name="addon"[^>]*value="([^"]+)"[^>]*data-price="(\d+)"/g)].map(m => [m[1], +m[2]]));
    assert.deepEqual(found, Object.fromEntries(DEFAULTS.catalog.addons.map(a => [a.name, a.price])));
  });
}

test('slot names and times match assets/js/app.js', () => {
  const js = read('assets/js/app.js');
  for (const s of DEFAULTS.hours.slots) {
    assert.match(js, new RegExp(`id:"${s.id}",\\s*label:"${s.label}",\\s*time:"${s.time}"`), s.id);
  }
});
