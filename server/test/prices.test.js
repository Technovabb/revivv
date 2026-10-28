// The server prices bookings itself, so its price list must match the website's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES, ADDONS, SEAT_ADDON, SEAT_ROW_PRICE, REWARD_OFF } from '../src/rules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

for (const file of ['assets/js/app.js', 'assets/js/portal.js']) {
  test(`package prices match ${file}`, () => {
    const js = read(file);
    for (const [label, p] of Object.entries(PACKAGES)) {
      const m = js.match(new RegExp(`${p.key}\\s*:\\s*\\{\\s*label\\s*:\\s*"([^"]+)"\\s*,\\s*price\\s*:\\s*\\{\\s*car\\s*:\\s*(\\d+)\\s*,\\s*suv\\s*:\\s*(\\d+)\\s*,\\s*truck\\s*:\\s*(\\d+)\\s*\\}[^}]*?long\\s*:\\s*(true|false)`));
      assert.ok(m, `${p.key} not found in ${file}`);
      assert.equal(m[1], label);
      assert.deepEqual([+m[2], +m[3], +m[4]], [p.price.car, p.price.suv, p.price.truck]);
      assert.equal(m[5] === 'true', p.long);
    }
    assert.match(js, new RegExp(`const REWARD_OFF\\s*=\\s*${REWARD_OFF.toFixed(2)};`));
  });
}

for (const file of ['src/pages/quote.html', 'src/pages/portal.html']) {
  test(`add-on prices match ${file}`, () => {
    const html = read(file).replace(/&amp;/g, '&');
    const found = Object.fromEntries([...html.matchAll(/name="addon"[^>]*value="([^"]+)"[^>]*data-price="(\d+)"/g)].map(m => [m[1], +m[2]]));
    assert.deepEqual(found, { ...ADDONS, [SEAT_ADDON]: SEAT_ROW_PRICE });
  });
}
