-- =====================================================================
-- VoucherFlow — catch-up fix: adds anything from updates 004–008 that may be missing.
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run any number of times.
-- =====================================================================

alter type public.voucher_status add value if not exists 'post_dated' after 'valid';

alter table public.companies
  add column if not exists date_type text not null default 'written',
  add column if not exists validity_months integer,
  add column if not exists urgent_days integer not null default 3,
  add column if not exists ai_hints text,
  add column if not exists ai_crop jsonb;

alter table public.vouchers
  add column if not exists send_by date,
  add column if not exists urgent boolean not null default false,
  add column if not exists hold_until date,
  add column if not exists date_text text,
  add column if not exists ai_data jsonb,
  add column if not exists sent_at timestamptz,
  add column if not exists sent_method text,
  add column if not exists sent_reference text,
  add column if not exists sent_by uuid references auth.users,
  add column if not exists received_at timestamptz,
  add column if not exists paid_at timestamptz;

alter table public.companies drop constraint if exists companies_date_type_check;
alter table public.companies add constraint companies_date_type_check check (date_type in ('expiry', 'issue', 'written'));
alter table public.companies alter column date_type set default 'written';
update public.companies set date_type = 'written', validity_months = null where date_type <> 'issue';
update public.companies set date_type = 'issue', validity_months = 6
 where (name ilike 'AAC%' or name ilike '%achisomoch%') and date_type <> 'issue';

-- Tell Supabase to pick up the new columns straight away.
notify pgrst, 'reload schema';

-- Shows what's there now (you should see hold_until and date_text in the list).
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'vouchers'
   and column_name in ('hold_until', 'date_text', 'send_by', 'urgent', 'ai_data', 'sent_at', 'paid_at')
 order by column_name;
