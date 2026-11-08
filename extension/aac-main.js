// VoucherFlow uploader — helper that runs inside the AAC portal page itself (not the add-on's
// separate space), so the portal's own upload code receives the pictures exactly as if you had
// chosen them in the "Browse files" window.
(() => {
  let armed = null // files waiting for the portal's next "choose files" window

  // The portal opens the file window by clicking a hidden file box. While pictures are waiting,
  // that click fills the box with them instead of opening the window.
  const realClick = HTMLInputElement.prototype.click
  HTMLInputElement.prototype.click = function (...args) {
    if (this.type === 'file' && armed) {
      const files = armed
      armed = null
      try {
        const dt = new DataTransfer()
        files.forEach((f) => dt.items.add(f))
        this.files = dt.files
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
        window.postMessage({ source: 'vf-main', type: 'filled', how: 'browse', count: files.length }, '*')
      } catch (e) {
        window.postMessage({ source: 'vf-main', type: 'fill-failed', error: String(e) }, '*')
      }
      return undefined
    }
    return realClick.apply(this, args)
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'vf-ext') return
    const d = e.data
    if (d.type === 'arm') {
      armed = d.files
      window.postMessage({ source: 'vf-main', type: 'armed', count: d.files.length }, '*')
    } else if (d.type === 'disarm') {
      armed = null
    } else if (d.type === 'set-input') {
      // Put the pictures straight into every file box on the page.
      const inputs = [...document.querySelectorAll('input[type=file]')]
      inputs.forEach((input) => {
        try {
          const dt = new DataTransfer()
          d.files.forEach((f) => dt.items.add(f))
          input.files = dt.files
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        } catch { /* try the next */ }
      })
      window.postMessage({ source: 'vf-main', type: 'filled', how: 'input', inputs: inputs.length }, '*')
    } else if (d.type === 'drop') {
      // "Drag and drop" the pictures onto the upload box.
      const zone = [...document.querySelectorAll('div,label,section,form')]
        .filter((el) => /drag and drop your voucher/i.test(el.innerText || ''))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]
      if (!zone) { window.postMessage({ source: 'vf-main', type: 'fill-failed', error: 'no drop box' }, '*'); return }
      const dt = new DataTransfer()
      d.files.forEach((f) => dt.items.add(f))
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
      window.postMessage({ source: 'vf-main', type: 'filled', how: 'drop' }, '*')
    }
  })
})()
