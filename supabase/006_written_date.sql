-- =====================================================================
-- VoucherFlow — update 6: vouchers whose date is just the date written (no expiry)
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
-- =====================================================================

alter table public.companies drop constraint if exists companies_date_type_check;
alter table public.companies add constraint companies_date_type_check
  check (date_type in ('expiry', 'issue', 'written'));

-- AHT: the date on the voucher is only the date it was written; AHT vouchers don't expire.
update public.companies set date_type = 'written', validity_months = null
 where name = 'AHT' or name ilike 'AHT %' or name ilike '%hatzdokoh%';
