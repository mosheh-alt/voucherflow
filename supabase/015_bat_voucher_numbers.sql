-- =====================================================================
-- VoucherFlow — update 15: BAT (Beis Aharon Trust) voucher numbers
--  * BAT voucher numbers keep their leading zeros, as printed (00280182, not 280182)
--  * the AI is told that this printed number is the voucher number, not the account number
--  * pending BAT vouchers already uploaded are corrected from their barcode
-- Paste into Supabase → SQL Editor → Run. Safe to run again.
-- =====================================================================

-- A company can keep the leading zeros of its voucher numbers.
alter table public.companies add column if not exists keep_zeros boolean not null default false;

update public.companies
set keep_zeros = true,
    barcode_pattern = 'BZ[SNP]\d{9}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})' || chr(10) ||
                      'BAT(?<tenths>\d{4})000(?<voucher>\d{8})(?<account>\d{3})\d{4}',
    ai_hints = 'The 8-digit number printed at the bottom left (e.g. 00280182, under the words "Account Number") is the VOUCHER number — the same number as in the barcode. Keep its leading zeros. Never give it as the account number: give account_number only if a different, separate account number is written on the voucher, otherwise null. The amount is in the £ box on the right and in words ("Eighteen Pounds only").'
where name = 'Beis Aharon Trust';

-- Pending BAT vouchers: take the full voucher number (with zeros) from the barcode …
update public.vouchers v
set voucher_number = substring(v.barcode_raw from '^BAT\d{4}000(\d{8})')
from public.companies c
where c.id = v.company_id and c.name = 'Beis Aharon Trust'
  and v.status = 'pending' and v.deleted_at is null
  and v.barcode_raw ~ '^BAT\d{4}000\d{8}'
  and v.voucher_number is distinct from substring(v.barcode_raw from '^BAT\d{4}000(\d{8})');

-- … and clear account numbers that are really just the voucher number.
update public.vouchers v
set donor_account = null
from public.companies c
where c.id = v.company_id and c.name = 'Beis Aharon Trust'
  and v.status = 'pending' and v.deleted_at is null
  and v.donor_account is not null and v.voucher_number is not null
  and ltrim(v.donor_account, '0') = ltrim(v.voucher_number, '0');

notify pgrst, 'reload schema';
