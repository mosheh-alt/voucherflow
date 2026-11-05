// Reads a barcode from an uploaded voucher image, in the browser.
// If the first attempt fails, it retries on zoomed-in parts of the image, sideways,
// and with a second image-cleaning method — this catches small or rotated barcodes.
import * as ZXing from '@zxing/library'

const {
  BarcodeFormat,
  BinaryBitmap,
  BrowserMultiFormatReader,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} = ZXing

const FORMATS = [
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.ITF,
  BarcodeFormat.CODABAR, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
  BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX, BarcodeFormat.PDF_417,
]

let reader = null
function getReader() {
  if (!reader) {
    reader = new MultiFormatReader()
    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS)
    hints.set(DecodeHintType.TRY_HARDER, true)
    reader.setHints(hints)
  }
  return reader
}

// Parts of the voucher to look at: [left, top, width, height] as fractions of the image.
// Many vouchers have the barcode along the bottom, so those parts come first.
const AREAS = [
  [0, 0, 1, 1],          // whole image
  [0, 0.55, 1, 0.45],    // bottom strip
  [0.45, 0.6, 0.55, 0.4], // bottom right
  [0, 0.6, 0.55, 0.4],   // bottom left
  [0, 0, 1, 0.45],       // top strip
  [0.45, 0, 0.55, 0.4],  // top right
  [0, 0, 0.55, 0.4],     // top left
  // Tight close-ups for small barcodes (e.g. BAT bottom left), enlarged more.
  [0, 0.72, 0.5, 0.28],
  [0.05, 0.78, 0.45, 0.2],
  [0.5, 0.72, 0.5, 0.28],
]
const MAX_SIDE = 2400

async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      /* fall back below */
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    img.src = url
  })
}

// Draw one area of the image, scaled (small areas are enlarged), optionally turned 90°.
function drawArea(img, [fx, fy, fw, fh], rotate) {
  const iw = img.width
  const ih = img.height
  const sx = Math.round(fx * iw)
  const sy = Math.round(fy * ih)
  const sw = Math.round(fw * iw)
  const sh = Math.round(fh * ih)
  // Enlarge small areas (up to 3x), shrink very large ones.
  const scale = Math.min(3, MAX_SIDE / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = rotate ? h : w
  canvas.height = rotate ? w : h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (rotate) {
    ctx.translate(h, 0)
    ctx.rotate(Math.PI / 2)
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)
  return canvas
}

// Turns a canvas into the grey-scale picture the barcode decoder works on.
// `stretch` spreads faint, greyish scans over the full black-to-white range first.
function luminanceFrom(canvas, stretch = false) {
  const { width, height } = canvas
  const rgba = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data
  const grey = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; j < grey.length; i += 4, j++) {
    grey[j] = (rgba[i] * 306 + rgba[i + 1] * 601 + rgba[i + 2] * 117) >> 10
  }
  if (stretch) {
    const hist = new Uint32Array(256)
    for (const g of grey) hist[g]++
    const cut = grey.length * 0.02
    let lo = 0, hi = 255, n = 0
    while (lo < 255 && (n += hist[lo]) < cut) lo++
    n = 0
    while (hi > 0 && (n += hist[hi]) < cut) hi--
    if (hi - lo > 10) {
      const k = 255 / (hi - lo)
      for (let j = 0; j < grey.length; j++) grey[j] = Math.max(0, Math.min(255, (grey[j] - lo) * k))
    }
  }
  return new RGBLuminanceSource(grey, width, height)
}

let warned = false
function tryCanvas(canvas, stretch = false) {
  const r = getReader()
  let source
  try {
    source = luminanceFrom(canvas, stretch)
  } catch (e) {
    if (!warned) { console.warn('Barcode reader: could not prepare image', e); warned = true }
    return null
  }
  for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
    try {
      const result = r.decodeWithState(new BinaryBitmap(new Binarizer(source)))
      if (result && result.getText()) return result.getText()
    } catch (e) {
      // "NotFoundException" just means no barcode in this attempt; anything else is worth knowing about.
      if (!warned && e && !/NotFound|Checksum|Format/i.test(e.name || e.constructor?.name || '')) {
        console.warn('Barcode reader error', e)
        warned = true
      }
    } finally {
      r.reset()
    }
  }
  return null
}

// The simple reader used in the first version, kept as a last resort.
let simpleReader = null
async function trySimple(file) {
  if (!BrowserMultiFormatReader) return null
  if (!simpleReader) {
    const hints = new Map()
    hints.set(DecodeHintType.TRY_HARDER, true)
    simpleReader = new BrowserMultiFormatReader(hints)
  }
  const url = URL.createObjectURL(file)
  try {
    const result = await simpleReader.decodeFromImageUrl(url)
    return result ? result.getText() : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Gives the browser a moment between attempts so the page stays responsive.
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0))

// Returns the barcode text, or null if no barcode could be read.
export async function readBarcode(file) {
  let img
  try {
    img = await loadImage(file)
  } catch {
    return (await trySimple(file))?.trim() || null
  }
  try {
    for (const rotate of [false, true]) {
      for (const area of AREAS) {
        const text = tryCanvas(drawArea(img, area, rotate))
        if (text) return text.trim()
        await breathe()
      }
    }
    // Faint or grey scans: try again with the contrast boosted.
    for (const area of AREAS) {
      const text = tryCanvas(drawArea(img, area, false), true)
      if (text) return text.trim()
      await breathe()
    }
  } finally {
    if (typeof img.close === 'function') img.close()
  }
  return (await trySimple(file))?.trim() || null
}
