// Small picture helpers shared by the AI reading code.

// Faint or grey scans: spread the picture over the full dark-to-light range so handwriting and
// small print stand out (the same correction a scanner's "auto contrast" makes).
export function autoLevels(ctx, w, h) {
  try {
    const img = ctx.getImageData(0, 0, w, h)
    const d = img.data
    const hist = new Uint32Array(256)
    const step = Math.max(1, Math.floor(d.length / 4 / 200000)) * 4 // sample at most ~200k pixels
    let n = 0
    for (let i = 0; i < d.length; i += step) { hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; n++ }
    const cut = n * 0.01
    let lo = 0, hi = 255, c = 0
    while (lo < 254 && (c += hist[lo]) < cut) lo++
    c = 0
    while (hi > 1 && (c += hist[hi]) < cut) hi--
    if (hi - lo < 40 || (lo < 8 && hi > 247)) return // already fine (or nothing to correct)
    const k = 255 / (hi - lo)
    const map = new Uint8ClampedArray(256)
    for (let v = 0; v < 256; v++) map[v] = (v - lo) * k
    for (let i = 0; i < d.length; i += 4) { d[i] = map[d[i]]; d[i + 1] = map[d[i + 1]]; d[i + 2] = map[d[i + 2]] }
    ctx.putImageData(img, 0, 0)
  } catch {
    /* leave the picture as it is */
  }
}
