import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { Attachment, Upload } from '../../shared/types';

const MAX = 5 * 1024 * 1024;
const OK_TYPE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;
const OK_NAME = /\.(png|jpe?g|gif|webp|pdf|txt|log|csv)$/i;

export interface Pending { name: string; type: string; size: number; data: string; preview?: string }

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const read = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

/**
 * Files waiting to be sent with a message: from the 📎 button, a paste (Ctrl+V a screenshot)
 * or drag and drop. Checked here for a quick answer; the server checks again, by the bytes.
 */
export function useUploads() {
  const [files, setFiles] = useState<Pending[]>([]);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);

  const add = useCallback(async (list: Iterable<File>) => {
    setError('');
    const incoming = [...list];
    const next: Pending[] = [];
    for (const raw of incoming) {
      // Pasted screenshots arrive as "image.png" with no useful name.
      const f = raw.name === 'image.png' ? new File([raw], `screenshot-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`, { type: raw.type }) : raw;
      if (!OK_TYPE.test(f.type) && !OK_NAME.test(f.name)) { setError(`“${f.name}” isn’t supported. Use a screenshot, PDF or .txt/.log file.`); continue; }
      if (f.size > MAX) { setError(`“${f.name}” is over 5 MB.`); continue; }
      const data = await read(f);
      next.push({ name: f.name, type: f.type || 'text/plain', size: f.size, data, preview: f.type.startsWith('image/') ? data : undefined });
    }
    setFiles((prev) => {
      const all = [...prev, ...next];
      if (all.length > 5) setError('Up to 5 files at a time.');
      return all.slice(0, 5);
    });
  }, []);

  const remove = (i: number) => setFiles((prev) => prev.filter((_, j) => j !== i));
  const clear = () => { setFiles([]); setError(''); };
  const uploads = (): Upload[] => files.map((f) => ({ name: f.name, type: f.type, data: f.data }));

  /** Spread onto a text box: paste a screenshot straight in. */
  const onPaste = (e: ClipboardEvent) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length) { e.preventDefault(); void add(pasted); }
  };
  /** Spread onto a drop area. */
  const dropProps = {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { if (e.dataTransfer.files.length) { e.preventDefault(); setOver(false); void add(e.dataTransfer.files); } },
  };
  return { files, error, over, add, remove, clear, uploads, onPaste, dropProps };
}

export function AttachButton({ onFiles, label = '📎' }: { onFiles: (f: FileList) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="b" onClick={() => input.current?.click()} title="Attach a screenshot or file (or paste one with Ctrl+V)" aria-label="Attach files">{label}</button>
      <input ref={input} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.log,.csv"
        onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ''; }} />
    </>
  );
}

export function PendingFiles({ files, remove }: { files: Pending[]; remove: (i: number) => void }) {
  if (!files.length) return null;
  return (
    <div className="pending" aria-label="Files to send">
      {files.map((f, i) => (
        <span className="pf" key={`${f.name}${i}`}>
          {f.preview ? <img src={f.preview} alt="" /> : <span className="ficon">{f.type === 'application/pdf' ? 'PDF' : 'TXT'}</span>}
          <span className="fname">{f.name}<small>{fileSize(f.size)}</small></span>
          <button type="button" onClick={() => remove(i)} aria-label={`Remove ${f.name}`}>×</button>
        </span>
      ))}
    </div>
  );
}

/** Files on a message: screenshots as thumbnails that open full size, everything else as a chip. */
export function Attachments({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <div className="atts">
      {items.map((a) => a.type.startsWith('image/')
        ? <a key={a.id} className="thumb" href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" title={`${a.name} · ${fileSize(a.size)}`}><img src={`/api/attachments/${a.id}`} alt={a.name} loading="lazy" /></a>
        : <a key={a.id} className="pf" href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer"><span className="ficon">{a.type === 'application/pdf' ? 'PDF' : 'TXT'}</span><span className="fname">{a.name}<small>{fileSize(a.size)}</small></span></a>)}
    </div>
  );
}
