/**
 * Identifica o tipo do arquivo pela assinatura (magic bytes).
 * A extensão e o Content-Type enviados pelo navegador são ignorados.
 */
export function sniffMime(buf: Buffer): string | null {
  const at = (offset: number, bytes: number[]) => bytes.every((b, i) => buf[offset + i] === b);
  const ascii = (offset: number, s: string) =>
    buf.subarray(offset, offset + s.length).toString('latin1') === s;
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (ascii(4, 'ftyp')) return 'video/mp4';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'ID3') || (buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}
