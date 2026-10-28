-- Revivv: accounts, customers, bookings and staff.
-- Money is BBD. Dates are Barbados dates (America/Barbados, no daylight saving).

-- Anyone who can sign in: customers and staff.
create table users (
  id            bigint generated always as identity primary key,
  email         text not null,
  password_hash text,               -- null until a password is set (a new staff member's invite link)
  created_at    timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

-- Signed-in browsers. Only a hash of the cookie is stored.
create table sessions (
  token_hash bytea primary key,
  user_id    bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

-- One-time links: password resets and staff invites.
create table password_tokens (
  token_hash bytea primary key,
  user_id    bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- Being in this table is the only thing that makes someone staff.
create table staff (
  user_id bigint primary key references users(id) on delete cascade,
  name    text not null
);

-- A customer is created by their first booking. Signing up later links by email.
create table customers (
  id               bigint generated always as identity primary key,
  email            text not null,
  name             text not null,
  phone            text,
  referral_code    text not null,
  referred_by      bigint references customers(id),
  referral_paid_at timestamptz,     -- when the referral credit went to both people
  stamps           int not null default 0 check (stamps between 0 and 6),
  credit           numeric(10,2) not null default 0 check (credit >= 0),
  created_at       timestamptz not null default now()
);
create unique index customers_email_key on customers (lower(email));
create unique index customers_referral_key on customers (upper(referral_code));

create table bookings (
  id             bigint generated always as identity primary key,
  customer_id    bigint not null references customers(id),
  booking_date   date not null,
  slot           text not null check (slot in ('priority', 'morning', 'afternoon', 'late')),
  status         text not null default 'booked' check (status in ('booked', 'completed', 'cancelled')),
  name           text not null,
  email          text not null,
  phone          text not null,
  vehicle_type   text not null,
  vehicle_desc   text,
  package        text not null,
  addons         text,
  total          numeric(10,2) not null,   -- worked out by the server
  quoted_total   numeric(10,2),            -- what the customer's screen showed
  reward_applied boolean not null default false,
  credit_used    numeric(10,2) not null default 0,
  location       text,
  parish         text,
  address        text,
  notes          text,
  referral_code  text,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  cancelled_at   timestamptz
);
-- One crew: one booking per slot per day. A cancelled booking frees the slot.
create unique index bookings_one_per_slot on bookings (booking_date, slot) where status <> 'cancelled';
create index bookings_customer_idx on bookings (customer_id);
create index bookings_date_idx on bookings (booking_date);
