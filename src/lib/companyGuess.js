// Suggests the company of a plain-number voucher from the number history
// (nearest known voucher, or the number pattern). See database update 9.
import { supabase } from './supabase.js'

// Returns { company_id, method: 'nearest' | 'pattern', from, distance } or null.
export async function suggestCompany(voucherNumber) {
  const num = String(voucherNumber || '').trim()
  if (!/^\d{4,18}$/.test(num)) return null
  const { data, error } = await supabase.rpc('suggest_company', { p_voucher: num, p_range: 50 })
  if (error || !data?.[0]?.company_id) return null
  const s = data[0]
  return { company_id: s.company_id, method: s.method, from: s.from_voucher, distance: s.distance }
}

// The database fields to store when the number history suggests a company.
export function historyPatch(voucher, suggestion) {
  if (!suggestion || voucher.company_id) return null
  return {
    company_id: suggestion.company_id,
    company_hint: { state: 'history', history: suggestion },
  }
}

// Combines the number history's opinion with the AI's.
//   Returns changes to company_id / company_hint, or {} when there's nothing to decide.
export function combineWithAi(voucher, aiCompanyId) {
  const hint = voucher.company_hint
  if (!hint || hint.state !== 'history' || !hint.history) return {}
  if (voucher.company_id !== hint.history.company_id) return {} // someone already changed it
  if (!aiCompanyId) return {}
  if (aiCompanyId === hint.history.company_id) {
    return { company_hint: { ...hint, state: 'agree', ai: aiCompanyId } }
  }
  // They disagree: leave the company empty and let a person choose.
  return { company_id: null, company_hint: { ...hint, state: 'conflict', ai: aiCompanyId } }
}
