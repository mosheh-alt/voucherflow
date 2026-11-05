// Converts Hebrew (Jewish calendar) dates to ordinary dates.
// Accepts e.g. "15 Cheshvan 5787", "15 Marcheshvan 5787", "ט"ו חשון תשפ"ז", "טו' חשון תשפז".
// Calendar arithmetic follows Reingold & Dershowitz, "Calendrical Calculations".

const HEBREW_EPOCH = -1373427 // fixed day number of 1 Tishri AM 1

const isLeap = (y) => (7 * y + 1) % 19 < 7
const lastMonth = (y) => (isLeap(y) ? 13 : 12)

function elapsedDays(y) {
  const months = Math.floor((235 * y - 234) / 19)
  const parts = 12084 + 13753 * months
  const days = 29 * months + Math.floor(parts / 25920)
  return (3 * (days + 1)) % 7 < 3 ? days + 1 : days
}

function yearLengthCorrection(y) {
  const ny0 = elapsedDays(y - 1)
  const ny1 = elapsedDays(y)
  const ny2 = elapsedDays(y + 1)
  if (ny2 - ny1 === 356) return 2
  if (ny1 - ny0 === 382) return 1
  return 0
}

const newYear = (y) => HEBREW_EPOCH + elapsedDays(y) + yearLengthCorrection(y)
const daysInYear = (y) => newYear(y + 1) - newYear(y)

// Months are numbered 1 = Nisan … 6 = Elul, 7 = Tishrei … 12 = Adar (Adar I in a leap year), 13 = Adar II.
function daysInMonth(m, y) {
  if ([2, 4, 6, 10, 13].includes(m)) return 29
  if (m === 12 && !isLeap(y)) return 29
  if (m === 8 && daysInYear(y) % 10 !== 5) return 29 // Cheshvan is short unless the year is "complete"
  if (m === 9 && daysInYear(y) % 10 === 3) return 29 // Kislev is short in a "deficient" year
  return 30
}

function fixedFromHebrew(y, m, d) {
  let fixed = newYear(y) + d - 1
  if (m < 7) {
    for (let mm = 7; mm <= lastMonth(y); mm++) fixed += daysInMonth(mm, y)
    for (let mm = 1; mm < m; mm++) fixed += daysInMonth(mm, y)
  } else {
    for (let mm = 7; mm < m; mm++) fixed += daysInMonth(mm, y)
  }
  return fixed
}

// Fixed day 730120 is 1 January 2000.
function isoFromFixed(fixed) {
  return new Date(Date.UTC(2000, 0, 1) + (fixed - 730120) * 86400000).toISOString().slice(0, 10)
}

export function hebrewToIso(year, month, day) {
  if (month === 13 && !isLeap(year)) month = 12 // "Adar II" in a non-leap year is just Adar
  if (month < 1 || month > lastMonth(year) || day < 1 || day > daysInMonth(month, year)) return null
  return isoFromFixed(fixedFromHebrew(year, month, day))
}

// ---------- Reading what people type ----------

const MONTHS = [
  [1, ['nisan', 'nissan', 'ניסן']],
  [2, ['iyar', 'iyyar', 'iyar', 'אייר', 'איר']],
  [3, ['sivan', 'סיון', 'סיוון']],
  [4, ['tamuz', 'tammuz', 'תמוז']],
  [5, ['av', 'menachem av', 'אב', 'מנחם אב']],
  [6, ['elul', 'אלול']],
  [7, ['tishrei', 'tishri', 'tishre', 'תשרי']],
  [8, ['cheshvan', 'marcheshvan', 'heshvan', 'chesvan', 'mar cheshvan', 'חשון', 'חשוון', 'מרחשון', 'מרחשוון']],
  [9, ['kislev', 'kislef', 'כסלו', 'כסליו']],
  [10, ['teves', 'tevet', 'tevais', 'טבת']],
  [11, ['shvat', 'shevat', 'shevet', 'שבט']],
  [13, ['adar ii', 'adar 2', 'adar sheni', 'adar b', 'אדר ב', 'אדר שני', "אדר ב'"]],
  [12, ['adar i', 'adar 1', 'adar rishon', 'adar a', 'adar', 'אדר א', 'אדר ראשון', "אדר א'", 'אדר']],
]

const LETTERS = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50, ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100, ר: 200, ש: 300, ת: 400 }

function gematria(word) {
  let n = 0
  for (const ch of word) if (LETTERS[ch]) n += LETTERS[ch]
  return n
}

function readNumber(token) {
  const t = token.replace(/["'׳״]/g, '')
  if (/^\d+$/.test(t)) return Number(t)
  if (/^[א-ת]+$/.test(t)) return gematria(t)
  return null
}

// Returns { iso, text } or null if it doesn't look like a Hebrew date.
export function parseHebrewDate(input) {
  if (!input) return null
  let s = ` ${String(input).toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim()} `
  let month = null
  for (const [num, names] of MONTHS) {
    for (const name of [...names].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`(^|\\s|ב|ל)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`)
      if (re.test(s)) {
        month = num
        s = s.replace(re, ' ')
        break
      }
    }
    if (month) break
  }
  if (!month) return null
  // "Rosh Chodesh" (ר"ח) = the 1st of the month.
  const roshChodesh = /(^|\s)(ר["'׳״]?ח|rosh chodesh|r"ch)(?=\s|$)/.test(s)
  if (roshChodesh) s = s.replace(/(^|\s)(ר["'׳״]?ח|rosh chodesh|r"ch)(?=\s|$)/, ' ')
  const numbers = s.trim().split(' ').filter(Boolean).map(readNumber).filter((n) => n !== null && n > 0)
  if (roshChodesh) numbers.unshift(1)
  if (numbers.length < 2) return null
  let [day, year] = numbers
  if (day > 30 && year <= 30) [day, year] = [year, day]
  if (year < 50) {
    // A short ordinary year next to a Hebrew month ("10 ניסן 26" = 2026): the Hebrew year that month falls in.
    // Tishrei–Kislev are in the autumn, so they belong to the next Hebrew year.
    year = 2000 + year + (month >= 7 && month <= 9 ? 3761 : 3760)
  } else if (year < 100) {
    year += 5700 // written without ת"ש: פ"ו = 86 → 5786
  } else if (year < 1000) {
    year += 5000 // written without the thousands: תשפ"ז = 787 → 5787
  }
  const iso = hebrewToIso(year, month, day)
  return iso ? { iso, text: String(input).trim() } : null
}
