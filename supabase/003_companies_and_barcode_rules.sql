-- =====================================================================
-- VoucherFlow — update 3: voucher companies and their barcode rules
-- Worked out from the London voucher sheet (69,303 barcodes analysed).
-- 25 companies (The Simcha Trust, Keren Shmuel and Ichud Talmidey Yesodeh Hatorah removed).
-- Paste into Supabase → SQL Editor → new snippet → Run. Safe to run again.
-- Existing companies with the same name get their barcode rule updated;
-- missing ones are added. Companies without a rule have plain-number vouchers.
-- =====================================================================

-- AAC may already exist under a slightly different name (from update 2).
update public.companies
   set name = 'AAC – Achisomoch Aid Company'
 where (name ilike '%achisomoch%' or name ilike 'AAC%')
   and not exists (select 1 from public.companies where name = 'AAC – Achisomoch Aid Company');

insert into public.companies (name, barcode_pattern, amount_divisor)
select v.name, v.pattern, 100
from (values
  ('AAC – Achisomoch Aid Company', 'AC[SNP]\d{9}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})'),
  ('UTA', 'UT[SNP]\d{9}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})'),
  ('AHT', 'AH[SNP]\d{9}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})'),
  ('Kehal Yisroel', 'GK[SNP]\d{9}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})'),
  ('Yad Shlomo', 'YS[SNP]\d{9}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})'),
  ('Zoreya Tzedokos', 'ZT[SNP]\d{9}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})'),
  ('Beis Aharon Trust', 'BZ[SNP]\d{9}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})
BAT(?<tenths>\d{4})0{5}(?<voucher>\d{6})(?<account>\d{3})\d{4}'),
  ('C.M.Z. LTD', 'CM[SNP](?=\d{16}$)\d{4}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})'),
  ('Best', 'BEST(?=\d{16}$)\d{4}0*(?<voucher>[1-9]\d*)(?<pence>\d{5})'),
  ('BCT', 'BCT\d{6}(?<voucher>\d{5,6})(?<pence>\d{5})'),
  ('Smart Giving', '(?<voucher>VB-[A-Z]{3}-\d{3}-[A-Z]{3})'),
  ('Tevini', null),
  ('Kahal Chassidim Bobov', null),
  ('Asser Bishvil', null),
  ('Belz Foundation LTD', null),
  ('Kehal Chasidai Wiznitz', null),
  ('Miffal', null),
  ('Hashomrim', null),
  ('Broom Foundation', null),
  ('Kolyom Trust Limited', null),
  ('MH Trust', null),
  ('Three Pillars Trust', null),
  ('Cosmon Belz Ltd', null),
  ('CAF', null),
  ('Charitys Trust', null)
) as v(name, pattern)
on conflict (name) do update
  set barcode_pattern = coalesce(excluded.barcode_pattern, public.companies.barcode_pattern);

-- Companies that no longer exist: The Simcha Trust, Keren Shmuel, Ichud Talmidey Yesodeh Hatorah.
-- Removed completely if nothing uses them; otherwise switched off (kept for history).
delete from public.companies c
 where c.name in ('The Simcha Trust', 'Keren Shmuel', 'Ichud Talmidey Yesodeh Hatorah')
   and not exists (select 1 from public.vouchers v where v.company_id = c.id)
   and not exists (select 1 from public.account_history h where h.company_id = c.id);
update public.companies
   set active = false, accepted = false, barcode_pattern = null
 where name in ('The Simcha Trust', 'Keren Shmuel', 'Ichud Talmidey Yesodeh Hatorah');

