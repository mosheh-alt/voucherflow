-- =====================================================================
-- VoucherFlow — update 6: two date types, and post-dated vouchers
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
--
--   'issue'   = the date starts a validity period (AAC: valid 6 months from the date)
--   'written' = just the date the voucher was written; it doesn't expire (all other companies)
--   Any voucher dated in the future is "post-dated": not usable until that date.
-- =====================================================================

-- New status for post-dated vouchers.
alter type public.voucher_status add value if not exists 'post_dated' after 'valid';

-- The date a post-dated voucher becomes usable.
alter table public.vouchers add column if not exists hold_until date;

-- Date types: only 'issue' and 'written' are used now ('expiry' kept only so old rows stay valid).
alter table public.companies drop constraint if exists companies_date_type_check;
alter table public.companies add constraint companies_date_type_check
  check (date_type in ('expiry', 'issue', 'written'));
alter table public.companies alter column date_type set default 'written';

-- Every company is "date written, no expiry"…
update public.companies set date_type = 'written', validity_months = null
 where date_type <> 'issue' or date_type is null;

-- …except AAC: valid for 6 months from the date on the voucher.
update public.companies set date_type = 'issue', validity_months = 6, urgent_days = 3
 where name ilike 'AAC%' or name ilike '%achisomoch%';
