-- =====================================================================
-- VoucherFlow — update 4: what the date on a voucher means
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
-- =====================================================================

-- Per company: is the printed date the expiry date, or the issue date with a validity period?
alter table public.companies
  add column if not exists date_type text not null default 'expiry',
  add column if not exists validity_months integer,
  add column if not exists urgent_days integer not null default 3;

alter table public.companies drop constraint if exists companies_date_type_check;
alter table public.companies add constraint companies_date_type_check check (date_type in ('expiry', 'issue'));

-- Per voucher: the last day it can be used, and whether it must go out urgently.
alter table public.vouchers
  add column if not exists send_by date,
  add column if not exists urgent boolean not null default false;

-- AAC: the date on the voucher is the issue date; valid for 6 months from it.
update public.companies
   set date_type = 'issue', validity_months = 6, urgent_days = 3
 where name ilike 'AAC%' or name ilike '%achisomoch%';
