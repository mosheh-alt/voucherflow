-- =====================================================================
-- VoucherFlow — update 14: learning from corrections
-- Every time a person changes or deletes a value that the barcode or the AI gave,
-- the app records what was read, what it should have been and what kind of mistake it was.
-- The AI is taught from these (per company). Paste into SQL Editor → Run. Safe to run again.
-- =====================================================================

create table if not exists public.ai_corrections (
  id           uuid primary key default gen_random_uuid(),
  voucher_id   uuid references public.vouchers(id) on delete cascade,
  company_id   uuid references public.companies(id) on delete cascade,
  field        text not null,          -- voucher_number | account_number | amount | date
  source       text not null,          -- ai | barcode
  wrong_value  text,                   -- what was read
  right_value  text,                   -- what the person confirmed (null = deleted, not on the voucher)
  kind         text not null,          -- digits | leading_zero | missing_digit | extra_digit | wrong_place | day_month | not_on_voucher | different
  detail       text,                   -- e.g. "1→4" for misread digits
  model        text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);

create index if not exists ai_corrections_company_idx on public.ai_corrections (company_id, created_at desc);
create index if not exists ai_corrections_voucher_idx on public.ai_corrections (voucher_id);

alter table public.ai_corrections enable row level security;

drop policy if exists "read corrections" on public.ai_corrections;
create policy "read corrections" on public.ai_corrections for select to authenticated
  using (public.my_role() is not null);

drop policy if exists "add corrections" on public.ai_corrections;
create policy "add corrections" on public.ai_corrections for insert to authenticated
  with check (public.my_role() is not null);

drop policy if exists "admin removes corrections" on public.ai_corrections;
create policy "admin removes corrections" on public.ai_corrections for delete to authenticated
  using (public.my_role() = 'admin');

notify pgrst, 'reload schema';
