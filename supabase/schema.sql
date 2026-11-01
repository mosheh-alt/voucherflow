-- =====================================================================
-- VoucherFlow — database setup (version 1)
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run once on a new, empty project.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Types ----------------------------------------------------
create type public.user_role as enum ('admin', 'batch_entry', 'reconciler');

create type public.voucher_status as enum (
  'pending',            -- scanned/uploaded, waiting for validation
  'valid',              -- validated by a person
  'not_valid',          -- failed a rule (e.g. expired at drop-off)
  'sent',               -- submitted to the voucher company
  'received_success',   -- company remittance: approved
  'received_pending',   -- company remittance: still processing
  'rejected',           -- company remittance: rejected (reason kept)
  'paid',               -- matched to bank payment
  'cancelled'
);

create type public.submission_method as enum ('physical', 'api', 'email', 'portal');

-- ---------- Users / roles --------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text,
  full_name   text,
  role        public.user_role not null default 'batch_entry',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- The very first user becomes admin; everyone after starts as batch entry.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    case when (select count(*) from public.profiles) = 0
         then 'admin'::public.user_role else 'batch_entry'::public.user_role end
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.my_role()
returns public.user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

-- ---------- Companies -------------------------------------------------
create table public.companies (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  submission_method  public.submission_method not null default 'physical',
  report_email       text,
  portal_url         text,
  address            text,
  -- Barcode rule: a regular expression. If it matches a scanned barcode,
  -- the voucher is assigned to this company. Optional named groups fill fields:
  --   (?<voucher>...) (?<amount>...) (?<account>...) (?<expiry>...)
  barcode_pattern    text,
  amount_divisor     integer not null default 100,   -- 100 = barcode amount is in pence
  expiry_format      text not null default 'YYMMDD',  -- YYMMDD, DDMMYY, YYYYMMDD, DDMMYYYY
  accepted           boolean not null default true,   -- false = company no longer valid
  notes              text,
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

-- ---------- Collectors ------------------------------------------------
create table public.collectors (
  id          uuid primary key default gen_random_uuid(),
  reference   text not null unique,
  name        text not null,
  email       text,
  phone       text,
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- Batches ---------------------------------------------------
create table public.batches (
  id                   uuid primary key default gen_random_uuid(),
  batch_no             bigint generated always as identity unique,
  collector_id         uuid not null references public.collectors,
  collector_reference  text not null,
  received_date        date not null default current_date,
  status               text not null default 'open' check (status in ('open', 'validated', 'closed')),
  notes                text,
  created_by           uuid references auth.users default auth.uid(),
  created_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

-- ---------- Vouchers --------------------------------------------------
create table public.vouchers (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null references public.batches,
  collector_id         uuid not null references public.collectors,
  collector_reference  text not null,
  image_path           text,
  file_name            text,
  barcode_raw          text,
  barcode_read         boolean not null default false,
  voucher_number       text,
  company_id           uuid references public.companies,
  amount               numeric(12,2),
  donor_account        text,
  expiry_date          date,
  status               public.voucher_status not null default 'pending',
  status_reason        text,
  prefilled            boolean not null default false,   -- fields filled from a rich barcode
  possible_duplicate   boolean not null default false,
  validated_by         uuid references auth.users,
  validated_at         timestamptz,
  created_by           uuid references auth.users default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index vouchers_batch_idx   on public.vouchers (batch_id);
create index vouchers_number_idx  on public.vouchers (voucher_number);
create index vouchers_status_idx  on public.vouchers (status);
create index vouchers_collector_idx on public.vouchers (collector_id);

-- ---------- Full history of every voucher change ----------------------
create table public.voucher_history (
  id          bigint generated always as identity primary key,
  voucher_id  uuid not null,
  changed_at  timestamptz not null default now(),
  changed_by  uuid,
  action      text not null,
  old_data    jsonb,
  new_data    jsonb
);
create index voucher_history_voucher_idx on public.voucher_history (voucher_id);

create or replace function public.log_voucher_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.voucher_history (voucher_id, changed_by, action, new_data)
    values (new.id, auth.uid(), 'created', to_jsonb(new));
  elsif tg_op = 'UPDATE' then
    insert into public.voucher_history (voucher_id, changed_by, action, old_data, new_data)
    values (new.id, auth.uid(),
            case when new.deleted_at is not null and old.deleted_at is null then 'deleted'
                 when new.status <> old.status then 'status: ' || old.status || ' → ' || new.status
                 else 'updated' end,
            to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end $$;

create trigger vouchers_history
  after insert or update on public.vouchers
  for each row execute function public.log_voucher_change();

-- Keep updated_at fresh, and lock the collector reference (admin only may change it).
create or replace function public.vouchers_before_update()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if new.collector_reference is distinct from old.collector_reference
     and public.my_role() is distinct from 'admin' then
    raise exception 'Only an admin can change the collector reference';
  end if;
  return new;
end $$;

create trigger vouchers_before_update
  before update on public.vouchers
  for each row execute function public.vouchers_before_update();

create or replace function public.batches_before_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.collector_reference is distinct from old.collector_reference
     and public.my_role() is distinct from 'admin' then
    raise exception 'Only an admin can change the collector reference';
  end if;
  return new;
end $$;

create trigger batches_before_update
  before update on public.batches
  for each row execute function public.batches_before_update();

-- Nothing is ever hard-deleted from these tables.
create or replace function public.block_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Records are never deleted; mark them as deleted instead';
end $$;

create trigger vouchers_no_delete before delete on public.vouchers
  for each row execute function public.block_delete();
create trigger batches_no_delete before delete on public.batches
  for each row execute function public.block_delete();
create trigger history_no_delete before delete on public.voucher_history
  for each row execute function public.block_delete();

-- ---------- Security rules (Row Level Security) -----------------------
alter table public.profiles        enable row level security;
alter table public.companies       enable row level security;
alter table public.collectors      enable row level security;
alter table public.batches         enable row level security;
alter table public.vouchers        enable row level security;
alter table public.voucher_history enable row level security;

-- Everyone signed in (and active) can read.
create policy "read profiles"   on public.profiles        for select to authenticated using (public.my_role() is not null);
create policy "read companies"  on public.companies       for select to authenticated using (public.my_role() is not null);
create policy "read collectors" on public.collectors      for select to authenticated using (public.my_role() is not null);
create policy "read batches"    on public.batches         for select to authenticated using (public.my_role() is not null);
create policy "read vouchers"   on public.vouchers        for select to authenticated using (public.my_role() is not null);
create policy "read history"    on public.voucher_history for select to authenticated using (public.my_role() is not null);

-- Admin manages users, companies.
create policy "admin updates profiles" on public.profiles for update to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
create policy "admin inserts companies" on public.companies for insert to authenticated
  with check (public.my_role() = 'admin');
create policy "admin updates companies" on public.companies for update to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- Admin and batch entry manage collectors.
create policy "add collectors" on public.collectors for insert to authenticated
  with check (public.my_role() in ('admin', 'batch_entry'));
create policy "edit collectors" on public.collectors for update to authenticated
  using (public.my_role() in ('admin', 'batch_entry')) with check (public.my_role() in ('admin', 'batch_entry'));

-- Batches & vouchers: admin and batch entry create; all roles may update (reconcilers move statuses later).
create policy "add batches" on public.batches for insert to authenticated
  with check (public.my_role() in ('admin', 'batch_entry'));
create policy "edit batches" on public.batches for update to authenticated
  using (public.my_role() is not null) with check (public.my_role() is not null);

create policy "add vouchers" on public.vouchers for insert to authenticated
  with check (public.my_role() in ('admin', 'batch_entry'));
create policy "edit vouchers" on public.vouchers for update to authenticated
  using (public.my_role() is not null) with check (public.my_role() is not null);

-- ---------- Voucher image storage -------------------------------------
insert into storage.buckets (id, name, public) values ('vouchers', 'vouchers', false)
  on conflict (id) do nothing;

create policy "read voucher images" on storage.objects for select to authenticated
  using (bucket_id = 'vouchers' and public.my_role() is not null);
create policy "upload voucher images" on storage.objects for insert to authenticated
  with check (bucket_id = 'vouchers' and public.my_role() in ('admin', 'batch_entry'));
-- No update or delete policy: images cannot be overwritten or removed from the app.
