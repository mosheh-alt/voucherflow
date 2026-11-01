// Reads a barcode from an uploaded voucher image, in the browser.
// If the first attempt fails, it retries on zoomed-in parts of the image, sideways,
// and with a second image-cleaning method — this catches small or rotated barcodes.
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HTMLCanvasElementLuminanceSource,
  HybridBinarizer,
  MultiFormatReader,
} from '@zxing/library'

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
  // Enlarge small areas up to 2x, shrink very large ones.
  const scale = Math.min(2, MAX_SIDE / Math.max(sw, sh))
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

function tryCanvas(canvas) {
  const r = getReader()
  for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
    try {
      const source = new HTMLCanvasElementLuminanceSource(canvas)
      const result = r.decodeWithState(new BinaryBitmap(new Binarizer(source)))
      if (result && result.getText()) return result.getText()
    } catch {
      /* not found in this attempt */
    } finally {
      r.reset()
    }
  }
  return null
}

// Gives the browser a moment between attempts so the page stays responsive.
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0))

// Returns the barcode text, or null if no barcode could be read.
export async function readBarcode(file) {
  let img
  try {
    img = await loadImage(file)
  } catch {
    return null
  }
  try {
    for (const rotate of [false, true]) {
      for (const area of AREAS) {
        const text = tryCanvas(drawArea(img, area, rotate))
        if (text) return text.trim()
        await breathe()
      }
    }
    return null
  } finally {
    if (typeof img.close === 'function') img.close()
  }
}
