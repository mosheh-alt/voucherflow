-- =====================================================================
-- VoucherFlow — update 17: instant picture previews
-- A tiny preview of every voucher picture (a few KB) is kept in the database, so it arrives
-- together with the batch / pool list and shows at once for everyone, on any computer.
-- The sharp picture follows only where it's needed (large / enlarged pictures).
-- Paste into Supabase → SQL Editor → Run. Safe to run again.
-- =====================================================================
create table if not exists public.voucher_previews (
  voucher_id  uuid primary key references public.vouchers(id) on delete cascade,
  batch_id    uuid references public.batches(id) on delete cascade,
  data        text not null,               -- small WebP/JPEG picture as a data: URL
  created_at  timestamptz not null default now()
);
create index if not exists voucher_previews_batch_idx on public.voucher_previews (batch_id);

alter table public.voucher_previews enable row level security;

drop policy if exists "read previews" on public.voucher_previews;
create policy "read previews" on public.voucher_previews for select to authenticated
  using (public.my_role() is not null);
drop policy if exists "add previews" on public.voucher_previews;
create policy "add previews" on public.voucher_previews for insert to authenticated
  with check (public.my_role() is not null);
drop policy if exists "update previews" on public.voucher_previews;
create policy "update previews" on public.voucher_previews for update to authenticated
  using (public.my_role() is not null) with check (public.my_role() is not null);

notify pgrst, 'reload schema';
