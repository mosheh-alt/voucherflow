import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const configured = Boolean(url && key)
export const supabase = configured ? createClient(url, key) : null

// Supabase returns at most 1,000 rows per request; this fetches all pages.
// `build` receives a fresh query each time, e.g. () => supabase.from('vouchers').select('*')
export async function fetchAll(build, pageSize = 1000) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...data)
    if (data.length < pageSize) break
  }
  return rows
}

export async function signedUrls(paths, seconds = 3600) {
  const list = paths.filter(Boolean)
  if (!list.length) return {}
  const { data, error } = await supabase.storage.from('vouchers').createSignedUrls(list, seconds)
  if (error) return {}
  const map = {}
  for (const item of data) if (item.signedUrl) map[item.path] = item.signedUrl
  return map
}
