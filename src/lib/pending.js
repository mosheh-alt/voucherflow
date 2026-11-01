// Hands files chosen in the "New batch" form over to the batch page, which uploads them.
let pending = null

export function setPendingFiles(batchId, files) {
  pending = files && files.length ? { batchId, files: Array.from(files) } : null
}

export function takePendingFiles(batchId) {
  if (!pending || pending.batchId !== batchId) return null
  const files = pending.files
  pending = null
  return files
}
