-- =====================================================================
-- VoucherFlow — update 10: duplicates linked to the voucher they match, and removing vouchers
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
-- =====================================================================

alter table public.vouchers
  add column if not exists duplicate_of   uuid references public.vouchers,
  add column if not exists deleted_reason text,
  add column if not exists deleted_by     uuid references auth.users;

create index if not exists vouchers_duplicate_of_idx on public.vouchers (duplicate_of);

notify pgrst, 'reload schema';
