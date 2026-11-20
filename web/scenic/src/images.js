// SPDX-License-Identifier: AGPL-3.0-or-later
// Preview image uploads (CLOUDFLARE-KONZEPT.md 2.9): type from the file's bytes (not its name or the
// browser's claim), size limit, pixel size from the header. JPG, PNG and WebP only.

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const RIGHTS = ['own', 'cc0', 'cc_by', 'licensed'];

/** {mime, ext, width, height} or null when the bytes are not a JPG, PNG or WebP. */
export function sniffImage(b) {
  if (b.length < 16) return null;
  const u32 = (i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mime: 'image/png', ext: 'png', width: u32(16), height: u32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = b[i + 2] << 8 | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { mime: 'image/jpeg', ext: 'jpg', height: b[i + 5] << 8 | b[i + 6], width: b[i + 7] << 8 | b[i + 8] };
      }
      i += 2 + len;
    }
    return { mime: 'image/jpeg', ext: 'jpg', width: null, height: null };
  }
  const str = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') {
    const kind = str(12, 4);
    let width = null, height = null;
    if (kind === 'VP8 ' && b.length > 30) { width = (b[26] | b[27] << 8) & 0x3fff; height = (b[28] | b[29] << 8) & 0x3fff; }
    else if (kind === 'VP8L' && b.length > 25) { const v = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24; width = (v & 0x3fff) + 1; height = ((v >>> 14) & 0x3fff) + 1; }
    else if (kind === 'VP8X' && b.length > 30) { width = 1 + (b[24] | b[25] << 8 | b[26] << 16); height = 1 + (b[27] | b[28] << 8 | b[29] << 16); }
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  return null;
}

export async function contentId(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...h.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
