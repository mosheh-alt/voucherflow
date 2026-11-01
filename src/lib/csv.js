function cell(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCSV(columns, rows) {
  const head = columns.map((c) => cell(c.label)).join(',')
  const body = rows.map((r) => columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(','))
  return [head, ...body].join('\r\n')
}

export function downloadCSV(filename, columns, rows) {
  const blob = new Blob(['﻿' + toCSV(columns, rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
