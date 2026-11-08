-- =====================================================================
-- VoucherFlow — ONE-OFF, run once at go-live: remove the test batches.
-- Put the test batch numbers in the list below (two places), run PART 1 to check, then PART 2.
-- The vouchers disappear from everything (batches, voucher management, reports, duplicates),
-- but what the AI learned from them is kept. Nothing about this stays in the app.
-- =====================================================================

-- PART 1 — check: which batches and how many vouchers will be removed
select b.batch_no, b.collector_reference, b.received_date, count(v.id) as vouchers
from public.batches b
left join public.vouchers v on v.batch_id = b.id and v.deleted_at is null
where b.batch_no = any (array[0])          -- ← test batch numbers, e.g. array[1,2,3,5]
group by b.batch_no, b.collector_reference, b.received_date
order by b.batch_no;

-- PART 2 — remove (run after checking PART 1)
-- update public.vouchers set deleted_at = now(), deleted_reason = 'Test data', submission_id = null
-- where deleted_at is null
--   and batch_id in (select id from public.batches where batch_no = any (array[0]));   -- ← same numbers
-- update public.vouchers set possible_duplicate = false, duplicate_of = null
-- where duplicate_of in (select id from public.vouchers where deleted_reason = 'Test data');
-- update public.batches set deleted_at = now(), notes = 'Test data'
-- where batch_no = any (array[0]);                                                     -- ← same numbers
