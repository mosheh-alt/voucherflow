-- =====================================================================
-- VoucherFlow — update 13: small copies of voucher pictures, so pages load quickly
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
-- =====================================================================

alter table public.vouchers add column if not exists thumb_path text;

notify pgrst, 'reload schema';
