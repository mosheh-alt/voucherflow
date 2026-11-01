-- =====================================================================
-- VoucherFlow — update 8: voucher pool — sending, receiving and payment details
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
-- =====================================================================

alter table public.vouchers
  add column if not exists sent_at        timestamptz,
  add column if not exists sent_method    text,
  add column if not exists sent_reference text,
  add column if not exists sent_by        uuid references auth.users,
  add column if not exists received_at    timestamptz,
  add column if not exists paid_at        timestamptz;

create index if not exists vouchers_company_status_idx on public.vouchers (company_id, status);

-- In case Supabase hasn't picked up columns added by earlier updates yet.
notify pgrst, 'reload schema';
