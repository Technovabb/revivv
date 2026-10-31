/*
 * Revivv's business rules. Prices, add-ons and slots come from the settings
 * (src/settings.js), so the owners can change them; the rules for using them live here.
 */
import { fail } from './util.js';

export const TZ = 'America/Barbados';

export const REWARD_OFF = 0.5;         // the 6th detail is half price (package only)
export const REWARD_AT = 5;            // stamps needed before the reward applies
export const MAX_STAMPS = 6;
export const REFERRAL_CREDIT = 25;     // to both people, once the new customer's first detail is done
export const LOCATIONS = ['Mobile — we come to them', 'Drop off — customer comes to us'];
export const SEAT_ADDON = 'Seat extraction shampoo';

// A booking's steps. "Open" bookings hold their slot and can still change.
export const OPEN = ['requested', 'confirmed', 'on_the_way', 'in_progress'];
export const STATUS_LABEL = {
  requested: 'Requested', confirmed: 'Confirmed', on_the_way: 'On the way', in_progress: 'Started',
  completed: 'Done', cancelled: 'Cancelled', no_show: 'No-show'
};

// Completed details in the last 12 months decide the tier.
export function tierFor(visits) {
  if (visits >= 6) return { tier: 'Gold', discount: 0.10 };
  if (visits >= 3) return { tier: 'Silver', discount: 0.05 };
  return { tier: 'Regular', discount: 0 };
}

export function findPackage(catalog, name, { activeOnly = true } = {}) {
  const p = catalog.packages.find(x => x.name === name);
  return p && (p.active || !activeOnly) ? p : null;
}

// "Ceramic spray sealant, Seat extraction shampoo ×2" → $110. Unknown items are refused.
export function addonsTotal(catalog, list, { activeOnly = true } = {}) {
  if (!list) return 0;
  let sum = 0;
  for (const raw of String(list).split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const rows = item.match(/^(.+?)\s*[×x]\s*([1-4])$/);
    const name = rows ? rows[1] : item;
    const a = catalog.addons.find(x => x.name === name && (x.active || !activeOnly));
    if (!a || (rows && !a.perRow) || (!rows && a.perRow)) fail(400, `Unknown add-on: ${item}`);
    sum += a.price * (rows ? Number(rows[2]) : 1);
  }
  return sum;
}

/*
 * The same sum the quote page does: package + add-ons, then the 6th-stamp
 * reward OR the tier discount (never both, package price only), then credit.
 */
export function priceBooking({ catalog, pkg, vehicle, addons, account, activeOnly = true }) {
  const p = findPackage(catalog, pkg, { activeOnly });
  if (!p) fail(400, 'Please pick a package.');
  const base = p.prices[vehicle];
  if (base == null) fail(400, 'Please pick your vehicle type.');
  let total = base + addonsTotal(catalog, addons, { activeOnly });
  let rewardApplied = false, creditUsed = 0;
  if (account) {
    if (account.rewardAvailable) { total -= base * REWARD_OFF; rewardApplied = true; }
    else if (account.discount > 0) total -= base * account.discount;
    if (account.credit > 0) { creditUsed = Math.min(account.credit, total); total -= creditUsed; }
  }
  return { total: Math.max(0, Math.round(total)), rewardApplied, creditUsed: Math.round(creditUsed * 100) / 100 };
}

// Today's date in Barbados, as 'YYYY-MM-DD'.
export function todayISO(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// The hour now in Barbados (0-23).
export function hourNow(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const weekday = iso => new Date(iso + 'T00:00:00Z').getUTCDay();

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "Thu 29 Oct" (or "Thu 29 Oct 2027" outside this year)
export function prettyDate(iso, today = todayISO()) {
  const d = new Date(iso + 'T12:00:00Z');
  const opts = { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (iso.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts).replace(',', '');
}

// The slot's start time as a Barbados timestamp, e.g. for "24 hours before".
export function slotStart(hours, iso, slotId) {
  const s = hours.slots.find(x => x.id === slotId);
  const m = s && /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(s.time);
  let h = 8, min = 0;
  if (m) { h = Number(m[1]) % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0); min = Number(m[2] || 0); }
  return new Date(`${iso}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00-04:00`);
}

export function slotText(hours, slotId) {
  const s = hours.slots.find(x => x.id === slotId);
  return s ? `${s.label} (${s.time})` : slotId;
}
