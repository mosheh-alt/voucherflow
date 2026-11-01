// Reads a barcode from an uploaded voucher image, in the browser.
import { BrowserMultiFormatReader, DecodeHintType } from '@zxing/library'

let reader = null

function getReader() {
  if (!reader) {
    const hints = new Map()
    hints.set(DecodeHintType.TRY_HARDER, true)
    reader = new BrowserMultiFormatReader(hints)
  }
  return reader
}

// Returns the barcode text, or null if no barcode could be read.
export async function readBarcode(file) {
  const url = URL.createObjectURL(file)
  try {
    const result = await getReader().decodeFromImageUrl(url)
    return result ? result.getText() : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
