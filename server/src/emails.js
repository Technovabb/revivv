/*
 * The emails Revivv sends, as plain text. Each returns { subject, body }.
 * b = the booking row, s = the settings, site = 'https://revivvbb.com'.
 */
import { prettyDate, slotText, STATUS_LABEL, MAX_STAMPS, REWARD_AT } from './rules.js';
import { firstName } from './util.js';

const sign = s => `\n\nRevivv Vehicle Detailing\n${s.business.phone} · WhatsApp https://wa.me/${s.business.whatsapp}\n`;
const money = n => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
const link = (site, b) => `${site}/my-booking.html?ref=${b.ref}&k=${b.access_key}`;

function details(b, s) {
  const lines = [
    `Booking: ${b.ref}`,
    `When: ${prettyDate(b.booking_date)}, ${slotText(s.hours, b.slot)}`,
    `Package: ${b.package} — ${b.vehicle_type}${b.vehicle_desc ? ` (${b.vehicle_desc})` : ''}`
  ];
  if (b.addons) lines.push(`Add-ons: ${b.addons}`);
  if (b.location) lines.push(b.location.startsWith('Mobile') ? `Where: we come to you${b.address ? ` — ${b.address}` : ''}${b.parish ? `, ${b.parish}` : ''}` : 'Where: drop off with us');
  lines.push(`Price: ${money(b.total)} BBD`);
  return lines.join('\n');
}

export const emails = {
  requested: (b, s, site) => ({
    subject: `We've got your booking request (${b.ref})`,
    body: `Hi ${firstName(b.name)},\n\nThanks for booking with Revivv. We'll confirm your slot shortly.\n\n${details(b, s)}\n\nSee your booking, message us or cancel:\n${link(site, b)}${sign(s)}`
  }),
  confirmed: (b, s, site) => ({
    subject: `Confirmed: ${prettyDate(b.booking_date)}, ${slotText(s.hours, b.slot)}`,
    body: `Hi ${firstName(b.name)},\n\nYour detail is confirmed.\n\n${details(b, s)}\n\nSee your booking or message us:\n${link(site, b)}${sign(s)}`
  }),
  moved: (b, s, site) => ({
    subject: `New time for your detail: ${prettyDate(b.booking_date)}, ${slotText(s.hours, b.slot)}`,
    body: `Hi ${firstName(b.name)},\n\nWe've moved your booking to a new time. If it doesn't suit you, reply or message us and we'll sort it out.\n\n${details(b, s)}\n\n${link(site, b)}${sign(s)}`
  }),
  reminder: (b, s, site) => ({
    subject: `See you tomorrow: ${slotText(s.hours, b.slot)}`,
    body: `Hi ${firstName(b.name)},\n\nA reminder that your Revivv detail is tomorrow.\n\n${details(b, s)}\n\n${b.location && b.location.startsWith('Mobile')
      ? 'Please make sure we can get to the vehicle, with water and power nearby if you have them.'
      : 'Please bring the vehicle to us at the start of your slot.'}\n\nNeed to change something? ${link(site, b)}${sign(s)}`
  }),
  on_the_way: (b, s, site) => ({
    subject: 'Revivv is on the way',
    body: `Hi ${firstName(b.name)},\n\nWe're on our way to you for your ${b.package}.\n\n${link(site, b)}${sign(s)}`
  }),
  completed: (b, s, site, c) => {
    const stamps = Math.min(c.stamps, MAX_STAMPS);
    const card = c.stamps >= REWARD_AT
      ? 'Your next detail is half price on the package. Sign in to My Revivv when you book and it comes off automatically.'
      : `You have ${stamps} of ${MAX_STAMPS} stamps. At ${REWARD_AT} stamps, your next detail is half price.`;
    const review = s.business.reviewUrl ? `\n\nHappy with the result? A quick review helps a small Barbados business a lot:\n${s.business.reviewUrl}` : '';
    return {
      subject: 'Thanks from Revivv',
      body: `Hi ${firstName(b.name)},\n\nThanks for choosing Revivv. Your ${b.package} is done.\n\n${card}${c.credit > 0 ? `\nYou also have ${money(c.credit)} credit to use on your next booking.` : ''}${review}\n\nYour receipt and photos:\n${link(site, b)}${sign(s)}`
    };
  },
  cancelled: (b, s, site) => ({
    subject: `Booking cancelled (${b.ref})`,
    body: `Hi ${firstName(b.name)},\n\nYour booking for ${prettyDate(b.booking_date)}, ${slotText(s.hours, b.slot)} is cancelled.${b.cancel_reason ? `\n\nReason: ${b.cancel_reason}` : ''}${Number(b.credit_used) > 0 ? `\n\nThe ${money(b.credit_used)} credit it used is back on your account.` : ''}\n\nBook again any time: ${site}/quote.html${sign(s)}`
  }),
  nudge: (c, s, site) => ({
    subject: 'Time for your next detail?',
    body: `Hi ${firstName(c.name)},\n\nIt's been a while since your last Revivv detail. Want us to bring the shine back?\n\nBook in a minute: ${site}/quote.html\n\nYou have ${Math.min(c.stamps, MAX_STAMPS)} of ${MAX_STAMPS} stamps.${c.credit > 0 ? ` And ${money(c.credit)} credit waiting.` : ''}\n\nDon't want these notes? Reply "stop", or switch them off in My Revivv: ${site}/my-account.html${sign(s)}`
  }),
  message_to_customer: (c, s, site, m) => ({
    subject: 'A message from Revivv',
    body: `Hi ${firstName(c.name)},\n\n${m.sender_name || 'Revivv'} wrote:\n\n${m.body}\n\nReply here: ${m.link || `${site}/my-messages.html`}${sign(s)}`
  }),
  message_to_staff: (c, s, site, m) => ({
    subject: `New message from ${c.name}`,
    body: `${c.name} wrote:\n\n${m.body}\n\nReply in the back office: ${site}/staff-messages.html?c=${c.id}\n`
  }),
  staff_new_booking: (b, s, site) => ({
    subject: `New booking: ${b.name}, ${prettyDate(b.booking_date)} ${slotText(s.hours, b.slot)}`,
    body: `A new booking is waiting to be confirmed.\n\n${details(b, s)}\nCustomer: ${b.name}, ${b.phone}${b.email ? `, ${b.email}` : ''}${b.notes ? `\nNotes: ${b.notes}` : ''}\n\nOpen it: ${site}/staff-booking.html?ref=${b.ref}\n`
  }),
  staff_cancelled: (b, s, site) => ({
    subject: `Cancelled by the customer: ${b.name}, ${prettyDate(b.booking_date)}`,
    body: `${b.name} cancelled ${b.ref} (${prettyDate(b.booking_date)}, ${slotText(s.hours, b.slot)}). The slot is free again.\n\n${site}/staff-booking.html?ref=${b.ref}\n`
  }),
  code: (code, s) => ({
    subject: `${code} is your Revivv sign-in code`,
    body: `Your Revivv sign-in code is:\n\n${code}\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email.${sign(s)}`
  })
};

export { STATUS_LABEL };
