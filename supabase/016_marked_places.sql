-- =====================================================================
-- VoucherFlow — update 16: places people mark on the voucher picture (📍)
-- Where a detail (voucher no., account no., amount, date) is on a voucher, marked by a person.
-- The AI learns each company's layout from these. Paste into SQL Editor → Run. Safe to run again.
-- =====================================================================
alter table public.vouchers add column if not exists marked_boxes jsonb;
notify pgrst, 'reload schema';
