// Runs on VoucherFlow pages: tells the app the add-on is here and passes jobs / results along.
const VERSION = chrome.runtime.getManifest().version
document.documentElement.dataset.voucherflowAddon = VERSION

window.addEventListener('message', async (e) => {
  if (e.source !== window || e.data?.source !== 'voucherflow-app') return
  const d = e.data
  if (d.type === 'upload-job') {
    await chrome.runtime.sendMessage({ type: 'new-job', job: d.job })
  } else if (d.type === 'get-results') {
    sendResults()
  } else if (d.type === 'result-handled') {
    await chrome.runtime.sendMessage({ type: 'result-handled', id: d.id })
  }
})

async function sendResults() {
  try {
    const { results } = await chrome.runtime.sendMessage({ type: 'get-results' })
    for (const result of results || []) window.postMessage({ source: 'voucherflow-addon', type: 'upload-result', result }, window.location.origin)
  } catch { /* add-on reloading */ }
}
// Results that arrive while the page is open (e.g. you submit on the portal in another tab).
setInterval(sendResults, 3000)
