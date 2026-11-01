-- =====================================================================
-- VoucherFlow — update 5: AI reading of vouchers
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
-- =====================================================================

-- What the AI read from each voucher, kept so its accuracy can be measured.
alter table public.vouchers
  add column if not exists ai_data jsonb;

-- App-wide settings (e.g. AI reading on/off).
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.app_settings enable row level security;

drop policy if exists "read settings" on public.app_settings;
create policy "read settings" on public.app_settings for select to authenticated
  using (public.my_role() is not null);
drop policy if exists "admin manages settings" on public.app_settings;
create policy "admin manages settings" on public.app_settings for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

insert into public.app_settings (key, value) values ('ai_reading', 'false')
  on conflict (key) do nothing;

-- AI accuracy: for every validated voucher the AI read, compare its guess with the confirmed value.
-- "read" = the AI gave a value; "correct" = that value matched what was confirmed.
create or replace view public.ai_accuracy with (security_invoker = true) as
with v as (
  select c.name as company,
         vo.company_id,
         vo.voucher_number, vo.donor_account, vo.amount, vo.expiry_date,
         vo.ai_data
  from public.vouchers vo
  join public.companies c on c.id = vo.company_id
  where vo.ai_data is not null
    and vo.deleted_at is null
    and vo.status not in ('pending', 'cancelled')
)
select company,
  count(*) as vouchers,
  count(*) filter (where ai_data->>'company_id' is not null) as company_read,
  count(*) filter (where ai_data->>'company_id' = company_id::text) as company_correct,
  count(*) filter (where ai_data->>'voucher_number' is not null) as number_read,
  count(*) filter (where ltrim(ai_data->>'voucher_number', '0') = ltrim(voucher_number, '0')) as number_correct,
  count(*) filter (where ai_data->>'account_number' is not null) as account_read,
  count(*) filter (where ltrim(ai_data->>'account_number', '0') = ltrim(donor_account, '0')) as account_correct,
  count(*) filter (where ai_data->>'amount' is not null) as amount_read,
  count(*) filter (where (ai_data->>'amount')::numeric = amount) as amount_correct,
  count(*) filter (where ai_data->>'date' is not null) as date_read,
  count(*) filter (where (ai_data->>'date')::date = expiry_date) as date_correct
from v
group by company
order by vouchers desc;

grant select on public.ai_accuracy to authenticated;
