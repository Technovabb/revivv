-- Revivv v2 (docs/REBUILD-PLAN.md): booking steps, messages, cars, job cards,
-- payments, vouchers, editable prices and hours, the email outbox and an audit log.

-- ---------- staff roles ----------
-- Owners see everything. Crew see the day's jobs and messages, not money or settings.
alter table staff add column role text not null default 'owner' check (role in ('owner', 'crew'));
alter table staff add column alerts boolean not null default true;   -- email me new bookings and messages

-- ---------- sign-in by emailed code ----------
create table login_codes (
  id         bigint generated always as identity primary key,
  email      text not null,
  code_hash  bytea not null,
  tries      int not null default 0,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index login_codes_email_idx on login_codes (lower(email), created_at desc);

-- ---------- customers ----------
-- Phone and walk-in customers may have no email; they just can't sign in.
alter table customers alter column email drop not null;
alter table customers add column address text;
alter table customers add column parish text;
alter table customers add column notes text;                          -- staff only
alter table customers add column reminders boolean not null default true;   -- "time for your next detail" notes
alter table customers add column last_nudge_at timestamptz;

create table vehicles (
  id          bigint generated always as identity primary key,
  customer_id bigint not null references customers(id) on delete cascade,
  type        text not null check (type in ('Car', 'SUV', 'Truck')),
  description text,            -- make, model, year: "Toyota Corolla 2019"
  colour      text,
  plate       text,
  notes       text,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index vehicles_customer_idx on vehicles (customer_id);

-- ---------- bookings: steps, references, sources, job card ----------
alter table bookings drop constraint bookings_status_check;
update bookings set status = 'requested' where status = 'booked';
alter table bookings alter column status set default 'requested';
alter table bookings add constraint bookings_status_check
  check (status in ('requested', 'confirmed', 'on_the_way', 'in_progress', 'completed', 'cancelled', 'no_show'));
drop index bookings_one_per_slot;
create unique index bookings_one_per_slot on bookings (booking_date, slot) where status not in ('cancelled', 'no_show');

alter table bookings alter column email drop not null;
alter table bookings add column ref text;
alter table bookings add column access_key text not null default replace(gen_random_uuid()::text, '-', '');  -- receipt and status links in emails
alter table bookings add column source text not null default 'website' check (source in ('website', 'phone', 'whatsapp', 'walk_in', 'instagram', 'other'));
alter table bookings add column vehicle_id bigint references vehicles(id) on delete set null;
alter table bookings add column assigned_to bigint references users(id) on delete set null;
alter table bookings add column staff_notes text;
alter table bookings add column condition_notes text;
alter table bookings add column checklist jsonb not null default '[]';     -- [{ "item": "...", "done": true }]
alter table bookings add column price_note text;                           -- why an owner changed the price
alter table bookings add column cancel_reason text;
alter table bookings add column confirmed_at timestamptz;
alter table bookings add column on_the_way_at timestamptz;
alter table bookings add column started_at timestamptz;
alter table bookings add column no_show_at timestamptz;
alter table bookings add column reminder_sent_at timestamptz;

update bookings set ref = 'RV-' || to_char(created_at at time zone 'America/Barbados', 'YYMMDD') || '-' || (1000 + id)::text;
alter table bookings alter column ref set not null;
create unique index bookings_ref_key on bookings (ref);

-- Who did what to a booking, newest last. Shown as the booking's timeline.
create table booking_events (
  id          bigint generated always as identity primary key,
  booking_id  bigint not null references bookings(id) on delete cascade,
  kind        text not null,
  actor_id    bigint references users(id) on delete set null,
  actor_name  text not null,          -- "Nick", "Customer", "Website", "Revivv"
  detail      text,
  created_at  timestamptz not null default now()
);
create index booking_events_booking_idx on booking_events (booking_id, id);
insert into booking_events (booking_id, kind, actor_name, detail, created_at)
  select id, 'created', 'Website', 'Booked on the website', created_at from bookings;
insert into booking_events (booking_id, kind, actor_name, detail, created_at)
  select id, 'completed', 'Revivv', 'Detail done', coalesce(completed_at, created_at) from bookings where status = 'completed';

-- ---------- messages: one conversation per customer ----------
create table messages (
  id          bigint generated always as identity primary key,
  customer_id bigint not null references customers(id) on delete cascade,
  booking_id  bigint references bookings(id) on delete set null,
  sender      text not null check (sender in ('customer', 'staff', 'system')),
  sender_id   bigint references users(id) on delete set null,
  sender_name text,
  body        text not null check (length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index messages_customer_idx on messages (customer_id, id);

create table message_reads (
  customer_id  bigint not null references customers(id) on delete cascade,
  side         text not null check (side in ('staff', 'customer')),
  last_read_id bigint not null default 0,
  primary key (customer_id, side)
);

-- ---------- photos on the job card ----------
create table booking_photos (
  id          bigint generated always as identity primary key,
  booking_id  bigint not null references bookings(id) on delete cascade,
  kind        text not null check (kind in ('before', 'after', 'damage')),
  file        text not null unique,   -- name in the uploads folder
  mime        text not null,
  bytes       int not null,
  caption     text,
  taken_by    bigint references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index booking_photos_booking_idx on booking_photos (booking_id);

-- ---------- money ----------
create table vouchers (
  id          bigint generated always as identity primary key,
  code        text not null,
  amount      numeric(10,2) not null check (amount > 0),
  balance     numeric(10,2) not null check (balance >= 0),
  buyer       text,
  recipient   text,
  note        text,
  expires_on  date,
  paid_method text,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  voided_at   timestamptz
);
create unique index vouchers_code_key on vouchers (upper(code));

-- A negative amount is a refund.
create table payments (
  id          bigint generated always as identity primary key,
  booking_id  bigint not null references bookings(id),
  amount      numeric(10,2) not null check (amount <> 0),
  method      text not null check (method in ('cash', 'card', 'bank_transfer', 'mobile', 'voucher', 'other')),
  voucher_id  bigint references vouchers(id),
  note        text,
  taken_by    bigint references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index payments_booking_idx on payments (booking_id);
create index payments_created_idx on payments (created_at);

-- ---------- emails waiting to go out ----------
-- 'held': there was no mailbox when it was written, so it is kept for staff to
-- read (and pass on by WhatsApp) and never sent later by surprise.
create table outbox (
  id          bigint generated always as identity primary key,
  to_addr     text not null,
  subject     text not null,
  body        text not null,
  kind        text not null,
  booking_id  bigint references bookings(id) on delete set null,
  customer_id bigint references customers(id) on delete set null,
  status      text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'held')),
  attempts    int not null default 0,
  last_error  text,
  send_after  timestamptz not null default now(),
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index outbox_pending_idx on outbox (send_after) where status = 'pending';
create index outbox_customer_idx on outbox (customer_id, kind, created_at);

-- ---------- settings the owners change ----------
-- Keys: catalog (packages and add-ons with prices), hours (slots and closed
-- weekdays), business (phone, review link, reminder timing). Missing keys use
-- the defaults in src/settings.js.
create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by bigint references users(id) on delete set null
);

create table closed_days (
  day        date primary key,
  reason     text,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- who changed what ----------
create table audit_log (
  id         bigint generated always as identity primary key,
  actor_id   bigint references users(id) on delete set null,
  actor_name text not null,
  action     text not null,
  detail     text,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on audit_log (created_at desc);
