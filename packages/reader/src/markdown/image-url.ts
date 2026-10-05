/** Resolve images against the document, never against the reader's hash route. */
export function imageUrl(src: string | undefined, documentUrl: string | undefined, pageUrl: string): string | undefined {
  if (!src) return undefined
  try {
    // An unconfigured content source may still contain absolute web images.
    if (!documentUrl && !/^https?:\/\//i.test(src)) return undefined
    const url = new URL(src, documentUrl ? new URL(documentUrl, pageUrl) : pageUrl)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}
