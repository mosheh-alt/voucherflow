-- =====================================================================
-- VoucherFlow — update 12: Cosmon (Belz) Ltd vouchers
-- Their barcode is a dummy (0000001) that is the same on every voucher, so the voucher
-- number has to be read from the print: bottom right, under "Voucher No.".
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
-- =====================================================================

update public.companies
   set ai_hints = 'The barcode is a dummy (0000001) — ignore it. Voucher number is printed bottom RIGHT under "Voucher No." '
               || '(7 digits, e.g. 4116721). Account number is bottom middle under "Account No." (often blank). '
               || 'Amount is in the £ box on the right and in words on the left (e.g. FIVE POUNDS ONLY). Date is top right on the Date line.',
       ai_crop = '["bottom_right", "bottom_middle", "middle_right", "top_right"]'::jsonb
 where name ilike 'Cosmon%';

select name, ai_crop from public.companies where name ilike 'Cosmon%';
