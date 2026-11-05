/**
 * What a preview of a page or a visual Claude made may load: scripts, styles and fonts from the
 * public CDNs; images only from itself; no other server. Both sides use it: the app puts it first
 * in every preview, and the server sends it with the document running previews load into.
 */
export const PREVIEW_CDNS = 'https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com';

export const PREVIEW_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${PREVIEW_CDNS}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${PREVIEW_CDNS}`,
  `font-src data: https://fonts.gstatic.com ${PREVIEW_CDNS}`,
  'img-src data: blob:',
  'media-src data: blob:',
  `connect-src ${PREVIEW_CDNS}`,
  'worker-src blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');
