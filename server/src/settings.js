/*
 * Settings the owners change in the back office: prices, hours and business
 * details. Stored in the settings table; anything not saved yet uses these
 * defaults, which match the website as it was built (test/prices.test.js).
 */
import { fail, text } from './util.js';

export const VEHICLE_TYPES = ['Car', 'SUV', 'Truck'];
export const SLOT_IDS = ['priority', 'morning', 'afternoon', 'late'];

export const DEFAULTS = {
  catalog: {
    packages: [
      { name: 'The Express Exterior', prices: { Car: 90, SUV: 110, Truck: 130 }, long: false, active: true,
        checklist: ['Pre-rinse and foam soak', 'Hand wash', 'Wheels: faces, barrels, calipers', 'Tyre scrub and dressing',
          'Door jambs wiped', 'Exterior glass', 'Detail spray finish'] },
      { name: 'All-Around Express', prices: { Car: 120, SUV: 150, Truck: 180 }, long: false, active: true,
        checklist: ['Foam soak and hand wash', 'Wheels and tyres', 'Quick interior vacuum and wipe', 'Windows in and out',
          'Tyre shine and trim', 'Door jambs', 'Air freshener'] },
      { name: 'The Express Interior', prices: { Car: 160, SUV: 190, Truck: 220 }, long: true, active: true,
        checklist: ['Full vacuum: seats, carpets, mats, trunk', 'Dash, console, vents, door panels', 'Plastic and vinyl dressing',
          'Steam vents, panels and upholstery', 'Interior glass', 'Air freshener'] },
      { name: 'Supreme Auto Valet', prices: { Car: 240, SUV: 270, Truck: 300 }, long: true, active: true,
        checklist: ['Foam soak, hand wash and wheels', 'Interior deep clean with extraction', 'Dressing',
          'Fabric and leather protection', 'Door jambs', 'Air freshener'] }
    ],
    addons: [
      { name: 'Ceramic spray sealant', price: 30, active: true },
      { name: 'Leather clean & condition', price: 40, active: true },
      { name: 'Pet hair removal', price: 25, active: true },
      { name: 'Seat extraction shampoo', price: 40, perRow: true, active: true }
    ]
  },
  hours: {
    slots: [
      { id: 'priority', label: 'Priority slot', time: '7:00am – 9:00am', goldOnly: true, long: false, active: true },
      { id: 'morning', label: 'Morning', time: '8:00am – 12:00pm', goldOnly: false, long: true, active: true },
      { id: 'afternoon', label: 'Afternoon', time: '12:00pm – 4:00pm', goldOnly: false, long: true, active: true },
      { id: 'late', label: 'Late afternoon', time: '4:00pm – 6:00pm', goldOnly: false, long: false, active: true }
    ],
    closedWeekdays: [0],          // 0 = Sunday (by appointment: staff can still book it)
    bookAheadDays: 366
  },
  business: {
    phone: '1-246-260-8228',
    phone2: '1-246-260-1662',
    whatsapp: '12462608228',
    instagram: 'revivv.bb',
    reviewUrl: '',                // the Google review link, once the Business Profile exists
    reminderHour: 10,             // reminders and "next detail" notes go out from this hour (Barbados)
    nudgeAfterDays: 42,           // "time for your next detail" this long after the last one; 0 = off
    cancelHours: 24               // customers can cancel online up to this many hours before
  }
};

const cache = { at: 0, value: null };

export function clearSettingsCache() { cache.at = 0; }

export async function getSettings(db) {
  if (cache.value && Date.now() - cache.at < 30_000) return cache.value;
  const rows = (await db.query('select key, value from settings')).rows;
  const saved = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const value = {
    catalog: saved.catalog || DEFAULTS.catalog,
    hours: saved.hours || DEFAULTS.hours,
    business: { ...DEFAULTS.business, ...(saved.business || {}) }
  };
  cache.value = value;
  cache.at = Date.now();
  return value;
}

/* ---------- checking what the back office sends ---------- */
function price(v, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000) fail(400, `${what}: enter a price between 0 and 10,000.`);
  return Math.round(n * 100) / 100;
}
function label(v, n, what) {
  const s = text(v);
  if (!s) fail(400, `${what} can't be empty.`);
  if (s.length > n) fail(400, `${what} is too long.`);
  if (/[,×]/.test(s)) fail(400, `${what} can't contain a comma or ×.`);
  return s;
}
function list(v, n, max, what) {
  if (!Array.isArray(v)) return [];
  if (v.length > max) fail(400, `${what}: at most ${max} lines.`);
  return v.map(x => text(x)).filter(Boolean).map(x => { if (x.length > n) fail(400, `${what}: a line is too long.`); return x; });
}

function checkCatalog(v) {
  const names = DEFAULTS.catalog.packages.map(p => p.name);
  if (!v || !Array.isArray(v.packages) || !Array.isArray(v.addons)) fail(400, 'The price list is incomplete.');
  // The packages are written into the website's pages, so their names stay fixed.
  if (v.packages.length !== names.length || !v.packages.every((p, i) => p && p.name === names[i])) {
    fail(400, 'The four packages can be repriced but not renamed or removed.');
  }
  const packages = v.packages.map((p, i) => ({
    name: names[i],
    prices: Object.fromEntries(VEHICLE_TYPES.map(t => [t, price(p.prices?.[t], `${names[i]} (${t})`)])),
    long: DEFAULTS.catalog.packages[i].long,
    active: p.active !== false,
    checklist: list(p.checklist, 80, 20, `${names[i]} checklist`)
  }));
  if (v.addons.length > 20) fail(400, 'At most 20 add-ons.');
  const seen = new Set();
  const addons = v.addons.map(a => {
    const name = label(a?.name, 60, 'An add-on name');
    if (seen.has(name.toLowerCase())) fail(400, `"${name}" is listed twice.`);
    seen.add(name.toLowerCase());
    const row = { name, price: price(a.price, name), active: a.active !== false };
    if (name === 'Seat extraction shampoo') row.perRow = true;
    return row;
  });
  return { packages, addons };
}

function checkHours(v) {
  if (!v || !Array.isArray(v.slots)) fail(400, 'The hours are incomplete.');
  const slots = SLOT_IDS.map(id => {
    const s = v.slots.find(x => x && x.id === id);
    const d = DEFAULTS.hours.slots.find(x => x.id === id);
    if (!s) return d;
    return {
      id, label: label(s.label, 40, 'A slot name'), time: label(s.time, 40, 'A slot time'),
      goldOnly: !!s.goldOnly, long: d.long, active: s.active !== false
    };
  });
  const closedWeekdays = [...new Set((v.closedWeekdays || []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  if (closedWeekdays.length === 7) fail(400, 'At least one day a week must be open.');
  const bookAheadDays = Math.min(Math.max(Number(v.bookAheadDays) || 366, 7), 366);
  return { slots, closedWeekdays, bookAheadDays };
}

function checkBusiness(v) {
  const s = (k, n) => { const x = text(v?.[k]); if (x.length > n) fail(400, `${k} is too long.`); return x; };
  const reviewUrl = s('reviewUrl', 300);
  if (reviewUrl && !/^https:\/\//.test(reviewUrl)) fail(400, 'The review link must start with https://');
  const int = (k, lo, hi) => { const n = Number(v?.[k]); if (!Number.isInteger(n) || n < lo || n > hi) fail(400, `${k} must be a whole number from ${lo} to ${hi}.`); return n; };
  return {
    phone: s('phone', 40) || DEFAULTS.business.phone,
    phone2: s('phone2', 40),
    whatsapp: s('whatsapp', 20).replace(/\D/g, '') || DEFAULTS.business.whatsapp,
    instagram: s('instagram', 60).replace(/^@/, ''),
    reviewUrl,
    reminderHour: int('reminderHour', 6, 20),
    nudgeAfterDays: int('nudgeAfterDays', 0, 365),
    cancelHours: int('cancelHours', 0, 168)
  };
}

const CHECKS = { catalog: checkCatalog, hours: checkHours, business: checkBusiness };

export async function saveSetting(db, key, value, actorId) {
  if (!Object.hasOwn(CHECKS, key)) fail(400, 'Unknown setting.');
  const clean = CHECKS[key](value);
  await db.query(
    `insert into settings (key, value, updated_at, updated_by) values ($1, $2, now(), $3)
     on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [key, JSON.stringify(clean), actorId]);
  clearSettingsCache();
  return clean;
}
