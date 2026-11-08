// VoucherFlow uploader — keeps the current upload job and the results, and opens the portal.
// Nothing here stores passwords: you log in to the portal yourself.

async function get(key) { return (await chrome.storage.local.get(key))[key] }
async function set(key, value) { await chrome.storage.local.set({ [key]: value }) }

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'new-job') {
      await set('job', { ...msg.job, state: 'waiting', received: Date.now() })
      await chrome.tabs.create({ url: msg.job.portal || 'https://charities.achisomoch.org/vouchers-scan.php' })
      reply({ ok: true })
    } else if (msg.type === 'get-job') {
      const job = await get('job')
      // Picture links last 24 hours; older jobs are dropped.
      if (job && Date.now() - job.received > 20 * 3600 * 1000) { await set('job', null); reply({ job: null }); return }
      reply({ job: job || null })
    } else if (msg.type === 'update-job') {
      const job = await get('job')
      if (job && job.id === msg.id) await set('job', { ...job, ...msg.patch })
      reply({ ok: true })
    } else if (msg.type === 'finish-job') {
      const results = (await get('results')) || {}
      results[msg.result.id] = { ...msg.result, at: Date.now() }
      await set('results', results)
      await set('job', null)
      reply({ ok: true })
    } else if (msg.type === 'get-results') {
      reply({ results: Object.values((await get('results')) || {}) })
    } else if (msg.type === 'result-handled') {
      const results = (await get('results')) || {}
      delete results[msg.id]
      await set('results', results)
      reply({ ok: true })
    } else if (msg.type === 'fetch-file') {
      // Fallback download (no CORS limits here): returns the picture as base64.
      try {
        const res = await fetch(msg.url)
        if (!res.ok) throw new Error(`download failed (${res.status})`)
        const buf = new Uint8Array(await res.arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        reply({ ok: true, type: res.headers.get('content-type') || 'image/jpeg', data: btoa(bin) })
      } catch (e) {
        reply({ ok: false, error: e.message })
      }
    }
  })()
  return true // answer asynchronously
})
