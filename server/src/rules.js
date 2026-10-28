/*
 * Revivv's business rules, mirrored from the website (assets/js/app.js and
 * src/pages/quote.html). test/prices.test.js fails if the two drift apart.
 */
export const TZ = 'America/Barbados';

export const SLOTS = ['priority', 'morning', 'afternoon', 'late'];
// Long packages need a 4-hour slot.
export const LONG_SLOTS = ['morning', 'afternoon'];

// Keyed by the label the booking form sends.
export const PACKAGES = {
  'The Express Exterior': { key: 'exterior', price: { car: 90, suv: 110, truck: 130 }, long: false },
  'All-Around Express': { key: 'allround', price: { car: 120, suv: 150, truck: 180 }, long: false },
  'The Express Interior': { key: 'interior', price: { car: 160, suv: 190, truck: 220 }, long: true },
  'Supreme Auto Valet': { key: 'supreme', price: { car: 240, suv: 270, truck: 300 }, long: true }
};
export const VEHICLES = { Car: 'car', SUV: 'suv', Truck: 'truck' };
export const ADDONS = { 'Ceramic spray sealant': 30, 'Leather clean & condition': 40, 'Pet hair removal': 25 };
export const SEAT_ADDON = 'Seat extraction shampoo';
export const SEAT_ROW_PRICE = 40;      // per row of seats, 1–4 rows
export const LOCATIONS = ['Mobile — we come to them', 'Drop off — customer comes to us'];

export const REWARD_OFF = 0.5;         // the 6th detail is half price (package only)
export const REWARD_AT = 5;            // stamps needed before the reward applies
export const MAX_STAMPS = 6;
export const REFERRAL_CREDIT = 25;     // to both people, once the new customer's first detail is done

// Completed details in the last 12 months decide the tier.
export function tierFor(visits) {
  if (visits >= 6) return { tier: 'Gold', discount: 0.10 };
  if (visits >= 3) return { tier: 'Silver', discount: 0.05 };
  return { tier: 'Regular', discount: 0 };
}

// "Ceramic spray sealant, Seat extraction shampoo ×2" → $110. Unknown items are refused.
export function addonsTotal(text) {
  if (!text) return 0;
  let sum = 0;
  for (const raw of String(text).split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const seat = item.match(/^Seat extraction shampoo\s*[×x]\s*([1-4])$/);
    if (seat) { sum += SEAT_ROW_PRICE * Number(seat[1]); continue; }
    if (!(item in ADDONS)) throw Object.assign(new Error(`Unknown add-on: ${item}`), { statusCode: 400 });
    sum += ADDONS[item];
  }
  return sum;
}

/*
 * The same sum the quote page does: package + add-ons, then the 6th-stamp
 * reward OR the tier discount (never both, package price only), then credit.
 */
export function priceBooking({ pkg, vehicle, addons, account }) {
  const base = PACKAGES[pkg].price[VEHICLES[vehicle]];
  let total = base + addonsTotal(addons);
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

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isSunday(iso) {
  return new Date(iso + 'T00:00:00Z').getUTCDay() === 0;
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
