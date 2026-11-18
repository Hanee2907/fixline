import type { Upload } from '../shared/types.js';

export const MAX_FILE = 5 * 1024 * 1024;
export const MAX_FILES = 5;

/**
 * Only file types that are useful on a help desk ticket and safe to show back in a browser.
 * The type is decided from the file's actual bytes, never from its name or the browser's claim,
 * so a script renamed to "screenshot.png" is refused. SVG and HTML are never accepted: both can
 * carry scripts.
 */
const KINDS: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { type: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { type: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

/** Plain-text logs: valid UTF-8 with no NUL bytes and no markup that a browser could run. */
function isPlainText(b: Buffer, name: string) {
  if (!/\.(txt|log|csv)$/i.test(name)) return false;
  if (b.includes(0)) return false;
  const text = b.toString('utf8');
  if (text.includes('�')) return false;
  return !/<\s*(script|html|svg|iframe)/i.test(text);
}

export interface CheckedFile { name: string; type: string; data: Buffer; size: number }

export function checkUploads(files: Upload[] | undefined): { ok: true; files: CheckedFile[] } | { ok: false; error: string } {
  if (!files?.length) return { ok: true, files: [] };
  if (files.length > MAX_FILES) return { ok: false, error: `Attach up to ${MAX_FILES} files at a time` };
  const out: CheckedFile[] = [];
  for (const f of files) {
    const base64 = f.data.includes(',') ? f.data.slice(f.data.indexOf(',') + 1) : f.data;
    const data = Buffer.from(base64, 'base64');
    if (!data.length) return { ok: false, error: `“${f.name}” is empty` };
    if (data.length > MAX_FILE) return { ok: false, error: `“${f.name}” is over 5 MB` };
    const name = f.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
    const kind = KINDS.find((k) => k.test(data));
    if (kind) out.push({ name, type: kind.type, data, size: data.length });
    else if (isPlainText(data, name)) out.push({ name, type: 'text/plain; charset=utf-8', data, size: data.length });
    else return { ok: false, error: `“${f.name}” isn’t a supported file. Use a screenshot (PNG, JPG, GIF, WebP), a PDF or a .txt/.log file.` };
  }
  return { ok: true, files: out };
}
