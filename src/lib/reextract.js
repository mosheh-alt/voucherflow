// Reads a voucher's barcode again from its stored image and applies the company rules.
import { supabase } from './supabase.js'
import { readBarcode } from './barcode.js'
import { interpretBarcode, isPlaceholderBarcode } from './rules.js'
import { suggestCompany } from './companyGuess.js'

// Returns { barcode, company, fields, prefilled }; barcode is null if none could be read.
export async function reextract(voucher, companies) {
  let barcode = null
  if (voucher.image_path) {
    const { data: blob } = await supabase.storage.from('vouchers').download(voucher.image_path)
    if (blob) barcode = await readBarcode(blob)
  }
  // If the image can't be read now, fall back to the barcode read at upload (rules may have changed).
  if (!barcode) barcode = voucher.barcode_raw || null
  const { company, fields, prefilled } = interpretBarcode(barcode, companies)
  // No company rule matched: the number history may still know the company.
  const history = !company && !voucher.company_id && fields.voucher_number ? await suggestCompany(fields.voucher_number) : null
  return { barcode, company, fields, prefilled, history }
}

// Database changes from a re-extraction: everything the barcode provides replaces what was there.
export function reextractPatch({ barcode, company, fields, prefilled, history }) {
  if (!barcode) return null
  const patch = { barcode_raw: barcode, barcode_read: true, prefilled }
  if (isPlaceholderBarcode(barcode)) {
    // Dummy barcode: drop the number it gave and the duplicate flag that came with it.
    return { ...patch, voucher_number: null, possible_duplicate: false }
  }
  if (!company && history) {
    patch.voucher_number = fields.voucher_number
    patch.company_id = history.company_id
    patch.company_hint = { state: 'history', history }
  }
  if (company) {
    patch.company_id = company.id
    patch.voucher_number = fields.voucher_number
    if (fields.amount != null) patch.amount = fields.amount
    if (fields.donor_account) patch.donor_account = fields.donor_account
    if (fields.expiry_date) patch.expiry_date = fields.expiry_date
  }
  return patch
}
