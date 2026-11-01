-- =====================================================================
-- VoucherFlow — update 7: AI hints and close-ups per company, Hebrew dates
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
-- =====================================================================

alter table public.companies
  add column if not exists ai_hints text,
  add column if not exists ai_crop jsonb;

-- The date exactly as written on the voucher (e.g. a Hebrew date), next to the converted date.
alter table public.vouchers
  add column if not exists date_text text;

-- Starting hints for AHT and AAC (edit any time in Companies → company → AI reading).
update public.companies
   set ai_hints = coalesce(ai_hints,
       'Voucher number is printed bottom left under VOUCHER NO. (8 digits, may start with 00). '
    || 'Account number is printed or written bottom left/middle under ACCOUNT NO. '
    || 'Amount is in the £ box on the right and in words on the left (e.g. Two Pounds only). '
    || 'The date is top right on the Date line; it is often handwritten and sometimes a Hebrew date.'),
       ai_crop = coalesce(ai_crop, '["bottom_left", "bottom_middle", "middle_right", "top_right"]'::jsonb)
 where name = 'AHT' or name ilike 'AHT %' or name ilike '%hatzdokoh%';

update public.companies
   set ai_hints = coalesce(ai_hints,
       'Account number is printed bottom middle under Account No., 6 digits with leading zeros (e.g. 006872). '
    || 'Amount is in the £ box on the right and in words on the left. '
    || 'The date is top right on the Date line (handwritten); vouchers are valid 6 months from that date.'),
       ai_crop = coalesce(ai_crop, '["bottom_middle", "middle_right", "top_right"]'::jsonb)
 where name ilike 'AAC%' or name ilike '%achisomoch%';
