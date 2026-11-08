// VoucherFlow uploader — runs on the AAC charity portal (charities.achisomoch.org).
// You log in yourself. With a job from VoucherFlow it: opens "Add New Vouchers", adds the pictures,
// waits until every one says "Uploaded", clicks Continue — and STOPS before Submit so you check
// and submit yourself. Then it tells VoucherFlow, which marks the submission as sent.
(() => {
  const CHUNK = 25 // pictures added at a time
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let job = null
  let running = false

  // ---------- the VoucherFlow box in the corner ----------
  const box = document.createElement('div')
  box.id = 'voucherflow-box'
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;background:#fff;border:2px solid #2563eb;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:13px/1.4 system-ui,Segoe UI,Arial;color:#111;padding:12px 14px'
  function show(html) {
    box.innerHTML = `<div style="font-weight:700;color:#2563eb;margin-bottom:6px">VoucherFlow uploader</div>${html}`
    if (!box.isConnected) document.body.appendChild(box)
  }
  const btn = (id, label, primary = true) =>
    `<button id="${id}" style="margin:8px 6px 0 0;padding:6px 12px;border-radius:6px;border:1px solid ${primary ? '#2563eb' : '#ccc'};background:${primary ? '#2563eb' : '#fff'};color:${primary ? '#fff' : '#111'};cursor:pointer;font-weight:600">${label}</button>`
  const on = (id, fn) => { const el = box.querySelector(`#${id}`); if (el) el.onclick = fn }
  const money = (n) => `£${Number(n || 0).toFixed(2)}`

  // ---------- finding things on the portal page ----------
  const visible = (el) => el && el.offsetParent !== null
  function byText(selector, re) {
    return [...document.querySelectorAll(selector)].find((el) => visible(el) && re.test((el.innerText || el.value || '').trim()))
  }
  const isLoginPage = () => Boolean(document.querySelector('input[type=password]')) && !document.querySelector('a[href*="vouchers"]')
  const onVoucherPage = () => /vouchers-scan/.test(location.pathname) || Boolean(byText('button,a', /^\+?\s*Add New Vouchers$/i))
  function portalAccount() {
    const m = (document.body.innerText || '').match(/ACCOUNT\s*\n?\s*(\d{3,6})/i)
    return m ? m[1] : null
  }
  // The "Upload vouchers" window (the smallest visible block containing its title and Continue).
  function uploadWindow() {
    return [...document.querySelectorAll('div,section,form')]
      .filter((el) => visible(el) && /Upload vouchers/i.test(el.innerText || '') && /Continue/i.test(el.innerText || ''))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0] || null
  }
  function uploadStates() {
    const text = (uploadWindow() || document.body).innerText || ''
    const count = (re) => (text.match(re) || []).length
    return {
      uploaded: count(/\bUploaded\b/gi),
      uploading: count(/\bUploading/gi),
      failed: count(/\b(failed|error|too large|not allowed|invalid file)\b/gi),
    }
  }
  async function waitFor(fn, ms, step = 300) {
    const end = Date.now() + ms
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step) }
    return null
  }

  // ---------- getting the pictures from VoucherFlow ----------
  async function getFile(f) {
    try {
      const res = await fetch(f.url)
      if (res.ok) { const b = await res.blob(); return new File([b], f.name, { type: b.type || 'image/jpeg' }) }
    } catch { /* fall back below */ }
    const r = await chrome.runtime.sendMessage({ type: 'fetch-file', url: f.url })
    if (!r?.ok) throw new Error(`Couldn't download ${f.name}: ${r?.error || 'unknown error'}`)
    const bin = atob(r.data)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new File([bytes], f.name, { type: r.type })
  }

  // Messages from the helper inside the page (aac-main.js).
  function fromMain(type, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { window.removeEventListener('message', h); resolve(null) }, ms)
      function h(e) {
        if (e.source !== window || e.data?.source !== 'vf-main') return
        if (type && e.data.type !== type && e.data.type !== 'fill-failed') return
        clearTimeout(t); window.removeEventListener('message', h); resolve(e.data)
      }
      window.addEventListener('message', h)
    })
  }
  const tell = (msg) => window.postMessage({ source: 'vf-ext', ...msg }, '*')
  const started = (before) => waitFor(() => { const s = uploadStates(); return s.uploaded + s.uploading > before }, 8000)

  // Puts files into the portal's upload box, trying three ways:
  //  1. click the portal's own "Browse files" — the helper hands the pictures to it instead of opening the window
  //  2. put them straight into the page's file box(es)
  //  3. "drop" them onto the drag-and-drop box
  const tried = []
  async function addFiles(files, before) {
    const browse = byText('button,a,label,span,div', /^browse files$/i)
    if (browse) {
      tell({ type: 'arm', files })
      await fromMain('armed', 2000)
      browse.click()
      const r = await fromMain('filled', 3000)
      tried.push(`browse:${r ? r.type : 'no click'}`)
      if (r?.type === 'filled' && await started(before)) return true
      tell({ type: 'disarm' })
    } else tried.push('browse:not found')
    tell({ type: 'set-input', files })
    const r2 = await fromMain('filled', 2000)
    tried.push(`input:${r2 ? (r2.inputs ?? r2.type) : 'no answer'}`)
    if (await started(before)) return true
    tell({ type: 'drop', files })
    const r3 = await fromMain('filled', 2000)
    tried.push(`drop:${r3 ? r3.type : 'no answer'}`)
    return Boolean(await started(before))
  }

  // Details to send to support when the portal didn't take the pictures.
  function diagnose() {
    const inputs = [...document.querySelectorAll('input[type=file]')].map((i) => `${i.id || '-'}|${i.name || '-'}|${i.accept || '-'}|${i.multiple ? 'multi' : 'single'}|${visible(i) ? 'shown' : 'hidden'}|${i.className || ''}`)
    const zone = byText('div,label,section', /drag and drop your voucher/i)
    const w = uploadWindow()
    return [
      `v${chrome.runtime.getManifest().version} ${location.pathname}`,
      `tried: ${tried.join(' ; ')}`,
      `file inputs (${inputs.length}): ${inputs.join(' || ')}`,
      `drop box: ${zone ? `${zone.tagName}.${zone.className}` : 'none'}`,
      `upload window: ${w ? `${w.tagName}.${w.className}` : 'none'} states ${JSON.stringify(uploadStates())}`,
      `scripts: ${[...document.scripts].map((x) => (x.src || '').split('/').pop()).filter(Boolean).join(', ').slice(0, 400)}`,
    ].join('\n')
  }

  // After Continue: the portal lists the vouchers it read. Compare them with VoucherFlow.
  function readPortalRows() {
    const rows = []
    for (const nameBox of document.querySelectorAll('input')) {
      const fileName = (nameBox.value || '').trim()
      if (!/\.(jpe?g|png|pdf)$/i.test(fileName)) continue
      let row = nameBox.parentElement
      while (row && row.querySelectorAll('input').length < 3) row = row.parentElement
      if (!row) continue
      const values = [...row.querySelectorAll('input')].map((i) => (i.value || i.placeholder || '').trim())
      const number = values.find((v) => /^\d{5,}$/.test(v)) || null
      const amountText = values.find((v) => /£\s*\d/.test(v)) || ''
      const amount = amountText ? Number(amountText.replace(/[^\d.]/g, '')) : null
      const around = `${row.previousElementSibling?.innerText || ''} ${row.innerText || ''}`
      rows.push({ fileName, number, amount, problem: /already submitted|error|invalid/i.test(around) ? around.trim().split('\n')[0].slice(0, 120) : null })
    }
    return rows
  }
  function compareWithJob(rows) {
    const bare = (x) => String(x || '').replace(/^0+/, '')
    const ours = new Map(job.files.map((f) => [f.name, f]))
    const mine = rows.filter((r) => ours.has(r.fileName))
    const others = rows.filter((r) => !ours.has(r.fileName))
    const mismatches = mine.filter((r) => {
      const f = ours.get(r.fileName)
      return (r.number && bare(r.number) !== bare(f.voucher_number)) || (r.amount != null && f.amount != null && Number(r.amount) !== Number(f.amount))
    })
    return { mine, others, mismatches, ours }
  }

  // ---------- the upload ----------
  async function run() {
    if (running) return
    running = true
    try {
      const account = portalAccount()
      show(`Submission <b>#${job.no}</b>: ${job.count} picture(s), ${money(job.total)}<br>Opening "Add New Vouchers"…`)
      const add = byText('button,a', /Add New Vouchers/i)
      if (!add) throw new Error('Couldn\'t find the "Add New Vouchers" button on this page.')
      add.click()
      const ready = await waitFor(() => document.querySelector('input[type=file]') || byText('div,label,section', /drag and drop your voucher/i), 10000)
      if (!ready) throw new Error('The upload window didn\'t open.')

      let done = 0
      for (let i = 0; i < job.files.length; i += CHUNK) {
        const part = job.files.slice(i, i + CHUNK)
        show(`Submission <b>#${job.no}</b>${account ? ` → account <b>${account}</b>` : ''}<br>Getting pictures ${i + 1}–${i + part.length} of ${job.count}…`)
        const files = []
        for (const f of part) files.push(await getFile(f))
        const before = uploadStates()
        const added = await addFiles(files, before.uploaded + before.uploading)
        if (!added) {
          const err = new Error('The portal didn\'t accept the pictures automatically. Please send the details below to support. Meanwhile use "Save pictures to a folder" in VoucherFlow and drag them in by hand.')
          err.details = diagnose()
          throw err
        }
        // Wait until every picture added so far says "Uploaded" (up to 5 minutes per group).
        const target = i + part.length
        const finished = await waitFor(() => {
          const s = uploadStates()
          show(`Submission <b>#${job.no}</b>${account ? ` → account <b>${account}</b>` : ''}<br>Uploading: <b>${s.uploaded}</b> of ${job.count} uploaded${s.uploading ? `, ${s.uploading} still uploading` : ''}${s.failed ? `, <span style="color:#b91c1c">${s.failed} failed</span>` : ''}…`)
          return s.uploaded >= target && s.uploading === 0 ? s : null
        }, 5 * 60 * 1000, 1000)
        if (!finished) {
          const s = uploadStates()
          throw new Error(`Only ${s.uploaded} of ${target} picture(s) finished uploading${s.failed ? ` (${s.failed} failed)` : ''}. Remove the failed ones on the portal and add them again, or try later.`)
        }
        done = finished.uploaded
      }
      await chrome.runtime.sendMessage({ type: 'update-job', id: job.id, patch: { state: 'uploaded' } })

      // Continue — then stop for the person to check and submit.
      const cont = await waitFor(() => { const b = byText('button,a,input[type=submit]', /^continue$/i); return b && !b.disabled ? b : null }, 20000)
      if (!cont) throw new Error(`All ${done} picture(s) uploaded, but the Continue button didn't become available. Click Continue yourself, then Submit.`)
      cont.click()
      await sleep(1500)
      askToSubmit(done, account)
    } catch (e) {
      show(`<div style="color:#b91c1c"><b>Stopped:</b> ${e.message}</div>
        ${e.details ? `<textarea readonly style="width:100%;height:90px;font:11px monospace;margin-top:6px">${e.details.replace(/</g, '&lt;')}</textarea>${btn('vf-copy', 'Copy details', false)}` : ''}
        ${btn('vf-retry', 'Try again')}${btn('vf-drop', 'Cancel this upload', false)}`)
      on('vf-copy', () => navigator.clipboard.writeText(e.details).then(() => { box.querySelector('#vf-copy').textContent = 'Copied ✓' }))
      on('vf-retry', () => { running = false; location.reload() })
      on('vf-drop', async () => { await chrome.runtime.sendMessage({ type: 'update-job', id: job.id, patch: { state: 'cancelled' } }); box.remove() })
    } finally {
      running = false
    }
  }

  function askToSubmit(done, account) {
    const rows = readPortalRows()
    const { mine, others, mismatches, ours } = compareWithJob(rows)
    const bad = (t) => `<div style="color:#b91c1c;margin-top:6px">${t}</div>`
    let check = ''
    if (rows.length) {
      check += `<div style="margin-top:6px">The portal lists <b>${mine.length}</b> of this submission's ${job.count} voucher(s).</div>`
      if (mismatches.length) {
        check += bad(`⚠ ${mismatches.length} differ from VoucherFlow: ` + mismatches.map((r) => {
          const f = ours.get(r.fileName)
          return `${f.voucher_number}: portal read ${r.number || '?'}${r.amount != null ? ` / £${r.amount}` : ''} (VoucherFlow £${f.amount})`
        }).join('; ') + ' — correct them on the portal before submitting.')
      }
      const flagged = mine.filter((r) => r.problem)
      if (flagged.length) check += bad(`⚠ The portal flags ${flagged.length} of them: ${flagged.map((r) => r.problem).join('; ')}`)
      if (others.length) check += bad(`⚠ ${others.length} other voucher(s) are also waiting under "For Submission" (not from this submission${others.some((r) => r.problem) ? ', some marked "already submitted"' : ''}). Delete or untick them on the portal so only this submission is sent.`)
      if (!mismatches.length && !others.length && mine.length === job.count) check += `<div style="color:#15803d;margin-top:6px">✓ Numbers and amounts match VoucherFlow.</div>`
    }
    show(`✓ <b>${done} of ${job.count}</b> picture(s) uploaded and Continue clicked.${check}<br>
      <b>Now check the portal's screen</b> (e.g. enter the date of any post-dated voucher), then click the portal's <b>Submit</b> button.<br><br>
      When the portal has confirmed it:${btn('vf-done', 'I submitted — tell VoucherFlow')}${btn('vf-later', 'Not now', false)}`)
    on('vf-done', () => finish(done, account))
    on('vf-later', () => box.remove())
  }

  async function finish(done, account) {
    await chrome.runtime.sendMessage({
      type: 'finish-job',
      result: { id: job.id, submitted: true, uploaded: done, account, reference: `AAC portal${account ? ` ${account}` : ''} ${new Date().toISOString().slice(0, 10)}` },
    })
    show(`✓ Done. VoucherFlow will mark submission <b>#${job.no}</b> as sent (open or switch to its VoucherFlow tab).${btn('vf-close', 'Close', false)}`)
    on('vf-close', () => box.remove())
  }

  // ---------- start ----------
  async function start() {
    const r = await chrome.runtime.sendMessage({ type: 'get-job' })
    job = r?.job
    if (!job || job.state === 'cancelled') return
    if (job.state === 'uploaded') { askToSubmit(job.count, portalAccount()); return }
    if (isLoginPage()) {
      show(`Submission <b>#${job.no}</b> (${job.count} picture(s), ${money(job.total)}) is waiting.<br><br><b>Log in</b> with the right Charity ID — the upload continues after that.`)
      return
    }
    if (!onVoucherPage()) {
      show(`Submission <b>#${job.no}</b> (${job.count} picture(s), ${money(job.total)}) is waiting.${btn('vf-go', 'Go to Vouchers')}`)
      on('vf-go', () => { location.href = 'https://charities.achisomoch.org/vouchers-scan.php' })
      return
    }
    const account = portalAccount()
    show(`Submission <b>#${job.no}</b> from VoucherFlow:<br><b>${job.count}</b> picture(s), total <b>${money(job.total)}</b>${account ? `<br>Logged in to account <b>${account}</b> — check it's the right one.` : ''}
      ${btn('vf-start', 'Start upload')}${btn('vf-cancel', 'Cancel', false)}`)
    on('vf-start', run)
    on('vf-cancel', async () => { await chrome.runtime.sendMessage({ type: 'update-job', id: job.id, patch: { state: 'cancelled' } }); box.remove() })
  }

  start()
})()
