-- =====================================================================
-- VoucherFlow — update 18: a voucher's own validity (e.g. a "VALID FOR 3 MONTHS" stamp)
-- Empty = the company's rule applies (AAC 6 months). A number = valid that many months from
-- the date on the voucher; 0 = no expiry. Set by the AI when it finds a stamp, or by a person.
-- Paste into Supabase → SQL Editor → Run. Safe to run again; existing vouchers are unchanged.
-- =====================================================================
alter table public.vouchers add column if not exists validity_months integer;
notify pgrst, 'reload schema';
