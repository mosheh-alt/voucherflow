-- =====================================================================
-- VoucherFlow — update 11: Miffal barcodes
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
--
-- A Miffal barcode is 12 digits, e.g. 436 001 04 051 4:
--   436 + 051 = voucher number 0436051 (printed with a leading 0)
--   001        = always the same
--   04         = amount code (04 = £3), see below
--   last digit = check digit
-- =====================================================================

alter table public.companies add column if not exists amount_codes jsonb;

update public.companies
   set barcode_pattern = '(?<voucher1>\d{3})001(?<amountcode>\d{2})(?<voucher2>\d{3})\d',
       amount_codes = '{"03": 2, "04": 3, "05": 5, "06": 10, "07": 18, "10": 50}'::jsonb
 where name ilike 'Miffal%' or name ilike 'Mifal%';

notify pgrst, 'reload schema';

select name, barcode_pattern, amount_codes from public.companies where name ilike 'Mif%';
