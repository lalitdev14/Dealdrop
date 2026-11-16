-- DealDrop price alerts. Run once in the Supabase SQL editor (safe to re-run).
-- The website talks to the database only through the three functions below;
-- the table itself is not readable or writable with the public (anon) key.

create extension if not exists pgcrypto;

create table if not exists public.dealdrop_alerts (
  id               bigint generated always as identity primary key,
  email            text not null check (length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  product_id       text not null check (length(product_id) <= 64),
  product_name     text not null check (length(product_name) <= 200),
  target_price     numeric(10,2) not null check (target_price > 0 and target_price < 100000),
  confirm_token    uuid not null default gen_random_uuid() unique,
  unsub_token      uuid not null default gen_random_uuid() unique,
  created_at       timestamptz not null default now(),
  confirm_sent_at  timestamptz,
  confirmed_at     timestamptz,
  triggered_at     timestamptz,
  triggered_price  numeric(10,2),
  unsubscribed_at  timestamptz,
  unique (email, product_id)
);

alter table public.dealdrop_alerts enable row level security;   -- no policies: no direct access with the anon key
revoke all on public.dealdrop_alerts from anon, authenticated;

-- Create or update an alert. Returns 'pending' (confirmation email on its way) or 'active'.
create or replace function public.dealdrop_create_alert(p_email text, p_product_id text, p_product_name text, p_target numeric)
returns text language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(p_email));
  n int;
  r public.dealdrop_alerts;
begin
  select count(*) into n from dealdrop_alerts
    where email = e and unsubscribed_at is null and triggered_at is null and product_id <> p_product_id;
  if n >= 25 then raise exception 'too_many_alerts' using hint = 'An email address can watch up to 25 products at once.'; end if;
  select count(*) into n from dealdrop_alerts where created_at > now() - interval '1 hour';
  if n >= 500 then raise exception 'busy' using hint = 'Too many new alerts right now. Try again in an hour.'; end if;

  insert into dealdrop_alerts as a (email, product_id, product_name, target_price)
  values (e, left(p_product_id, 64), left(p_product_name, 200), round(p_target, 2))
  on conflict (email, product_id) do update set
    target_price    = excluded.target_price,
    product_name    = excluded.product_name,
    triggered_at    = null,
    triggered_price = null,
    -- coming back after unsubscribing (or never confirmed) needs a fresh confirmation
    confirmed_at    = case when a.unsubscribed_at is null then a.confirmed_at end,
    -- don't re-send a confirmation email more than once a day for the same alert
    confirm_sent_at = case when a.unsubscribed_at is null and (a.confirmed_at is not null or a.confirm_sent_at > now() - interval '24 hours') then a.confirm_sent_at end,
    confirm_token   = case when a.unsubscribed_at is null then a.confirm_token else gen_random_uuid() end,
    unsubscribed_at = null
  returning * into r;
  return case when r.confirmed_at is null then 'pending' else 'active' end;
end $$;

-- Confirm from the link in the confirmation email.
create or replace function public.dealdrop_confirm_alert(p_token uuid)
returns json language sql security definer set search_path = public as $$
  update dealdrop_alerts set confirmed_at = coalesce(confirmed_at, now())
  where confirm_token = p_token and unsubscribed_at is null
  returning json_build_object('product_id', product_id, 'product_name', product_name, 'target_price', target_price);
$$;

-- Unsubscribe from the link in any email. p_all = true stops every alert for that address.
create or replace function public.dealdrop_unsubscribe(p_token uuid, p_all boolean default false)
returns int language plpgsql security definer set search_path = public as $$
declare e text; n int;
begin
  select email into e from dealdrop_alerts where unsub_token = p_token;
  if e is null then return 0; end if;
  update dealdrop_alerts set unsubscribed_at = now()
    where unsubscribed_at is null and (unsub_token = p_token or (p_all and email = e));
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.dealdrop_create_alert(text, text, text, numeric) from public;
revoke all on function public.dealdrop_confirm_alert(uuid) from public;
revoke all on function public.dealdrop_unsubscribe(uuid, boolean) from public;
grant execute on function public.dealdrop_create_alert(text, text, text, numeric) to anon, authenticated;
grant execute on function public.dealdrop_confirm_alert(uuid) to anon, authenticated;
grant execute on function public.dealdrop_unsubscribe(uuid, boolean) to anon, authenticated;
