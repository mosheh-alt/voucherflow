// Finding duplicate vouchers and removing them.
import { supabase } from './supabase.js'

// Statuses where a voucher may still be removed (not yet sent to the company).
export const REMOVABLE = ['pending', 'valid', 'post_dated', 'not_valid']

// Looks for another voucher with the same number and the same company
// (or where one of the two has no company yet). Returns its id, or null.
export async function findDuplicate({ id, voucher_number, company_id }) {
  if (!voucher_number) return null
  let q = supabase
    .from('vouchers')
    .select('id, company_id')
    .eq('voucher_number', voucher_number)
    .is('deleted_at', null)
    .order('created_at')
    .limit(20)
  if (id) q = q.neq('id', id)
  const { data } = await q
  const match = (data || []).find((o) => !company_id || !o.company_id || o.company_id === company_id)
  return match ? match.id : null
}

// The duplicate fields to save on a voucher.
export function duplicateFields(otherId) {
  return otherId ? { possible_duplicate: true, duplicate_of: otherId } : { possible_duplicate: false }
}

// Removes a voucher (it stays in the history and can be restored).
export async function removeVoucher(id, reason, userId) {
  const { error } = await supabase
    .from('vouchers')
    .update({ deleted_at: new Date().toISOString(), deleted_reason: reason, deleted_by: userId })
    .eq('id', id)
  if (error) throw error
}

export async function restoreVoucher(id) {
  const { error } = await supabase
    .from('vouchers')
    .update({ deleted_at: null, deleted_reason: null, deleted_by: null })
    .eq('id', id)
  if (error) throw error
}
