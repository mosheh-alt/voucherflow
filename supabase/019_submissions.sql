-- =====================================================================
-- VoucherFlow — update 19: submissions
-- A submission = one send of vouchers to one company (e.g. one upload to the AAC portal).
-- It records which vouchers went together, when, how, the total, and the company's reference,
-- and is what "expected deposits" will be based on.
-- Paste into Supabase → SQL Editor → Run. Safe to run again.
-- =====================================================================
create table if not exists public.submissions (
  id             uuid primary key default gen_random_uuid(),
  submission_no  bigint generated always as identity unique,
  company_id     uuid not null references public.companies(id),
  method         text not null default 'portal',      -- portal | email | physical | api
  status         text not null default 'draft',       -- draft | sent | cancelled
  voucher_count  integer not null default 0,
  total          numeric(12,2) not null default 0,
  reference      text,                                -- confirmation / reference from the company
  portal_account text,                                -- e.g. the charity ID used on the portal
  notes          text,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  sent_by        uuid references auth.users(id)
);
create index if not exists submissions_company_idx on public.submissions (company_id, created_at desc);

alter table public.vouchers add column if not exists submission_id uuid references public.submissions(id) on delete set null;
create index if not exists vouchers_submission_idx on public.vouchers (submission_id);

alter table public.submissions enable row level security;
drop policy if exists "read submissions" on public.submissions;
create policy "read submissions" on public.submissions for select to authenticated
  using (public.my_role() is not null);
drop policy if exists "add submissions" on public.submissions;
create policy "add submissions" on public.submissions for insert to authenticated
  with check (public.my_role() is not null);
drop policy if exists "edit submissions" on public.submissions;
create policy "edit submissions" on public.submissions for update to authenticated
  using (public.my_role() is not null) with check (public.my_role() is not null);

-- AAC is sent by uploading on its charity portal.
update public.companies
set submission_method = 'portal', portal_url = coalesce(portal_url, 'https://charities.achisomoch.org/vouchers-scan.php')
where name = 'AAC – Achisomoch Aid Company';

notify pgrst, 'reload schema';
