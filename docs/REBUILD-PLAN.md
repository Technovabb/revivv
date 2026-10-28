# Revivv back end, version 2: the plan

28 Oct 2026. Built the H&R way (our own server, not Odoo), with everything useful to a detailing business.
Same server, same address (api.revivvbb.com), same website. Today's customers, stamps, bookings and staff carry over.
Revivv's own mailbox comes later: until then emails wait in an outbox the owners can see, and password sign-in keeps working.

## What goes in

1. **Bookings with steps** (from H&R): Requested → Confirmed → On the way → Started → Done, plus Cancelled and No-show.
   - Each booking has a reference like `RV-261028-4821` and a timeline of who did what.
   - Staff can move a booking, cancel it with a reason, and take **phone, WhatsApp and walk-in bookings** themselves.
   - Customers can cancel online up to 24 hours before.
   - Owners are told the moment a booking comes in.
2. **Messages** (from H&R): one conversation per customer, like a chat. Each booking step shows in it. Unread badges, with an email to the other side.
3. **Reminders and follow-ups:** a reminder the day before; a thank-you with the stamp count and a Google review link; and a "time for your next detail" note 6 weeks later. Customers can switch these off.
4. **Customers and cars:** each customer's details, cars (make, colour, plate), address for mobile jobs, notes, history, spend, stamps, credit and tier.
5. **Job card for the crew:** the package checklist, condition notes, and **before, after and damage photos**. Photos protect Revivv if a customer claims damage.
6. **Payments and receipts:** record cash, card, bank transfer or mobile payments, part payments and refunds. Every booking shows paid or owing, with a receipt the customer can open. Online card payments come once Revivv has a merchant account.
7. **Rewards and referrals,** as now. Owners can adjust stamps or credit, with a reason.
8. **Gift vouchers:** sell a voucher with a code, and use it as payment until the balance runs out.
9. **Prices, hours and closed days** changed in the back office, with no code change. The website reads them.
10. **Reports:** money taken today, this week and this month; jobs by package; new against returning customers; busiest days; no-shows; top customers; and a CSV download for the accountant.
11. **Staff:** owners see everything. Crew see the day's jobs and messages, but not money, reports or settings. Owners add and remove staff themselves, and an audit log records who changed what.
12. **Sign-in by a 6-digit email code** (from H&R), once the mailbox is ready. Passwords keep working.

## The pages

**Customers (on revivvbb.com):**
- **Book** (the quote page, as now).
- **My Revivv**: bookings with their steps, the rewards card, messages, cars, and settings.

**Back office (works on a phone):**
- **Today**
- **Bookings**, a booking's page, and **New booking**
- **Customers** and a customer's page
- **Messages**
- **Money** (payments and vouchers)
- **Reports**
- **Settings** (prices, hours, closed days)
- **Staff**
- **Outbox** (emails waiting to be sent)

## Not copied from H&R

Live maps and tracking, the fleet, rate grids, visitor counts, and the authenticator-app 2-step.

## Later

- Revivv's mailbox, then the emails start sending.
- Online card payments.
- The app in the App Store and Google Play, using the H&R wrapper.
