import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { SLA, formatLeft, slaState } from '../../shared/sla';
import type { Person, Ticket } from '../../shared/types';

/* ---------- Icons (inline, so there's no icon font to load) ---------- */
const paths: Record<string, string> = {
  inbox: 'M4 6h16M4 12h16M4 18h10',
  me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  plus: 'M12 5v14M5 12h14',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  pause: 'M10 4H6v16h4zM18 4h-4v16h4z',
  check: 'M20 6 9 17l-5-5',
  book: 'M5 4h11l3 3v13H5zM9 10h6M9 14h6',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  swap: 'M7 16V4M7 4 3 8M7 4l4 4M17 8v12M17 20l4-4M17 20l-4-4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  back: 'M19 12H5M12 19l-7-7 7-7',
};
export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? ''} />
    </svg>
  );
}

export function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h5l2-5 3 10 2-5h4" /></svg>
    </span>
  );
}

/* ---------- People ---------- */
const COLOURS = ['#7c5cff', '#12a150', '#e5484d', '#0f8fb3', '#d6336c', '#c2410c', '#2f3aa8', '#5c7c2f', '#b45309', '#0e7490'];
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
export function colourFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
}
export function Avatar({ person, size, me }: { person: Pick<Person, 'name'> | null; size?: 'sm'; me?: boolean }) {
  if (!person) return <span className={`av none ${size ?? ''}`} title="Unassigned">?</span>;
  const bg = me ? 'linear-gradient(135deg,#ffb86b,#ff6b9a)' : colourFor(person.name);
  return <span className={`av ${size ?? ''}`} style={{ background: bg }} title={person.name}>{initials(person.name)}</span>;
}

/* ---------- Time ---------- */
/** Re-renders every `ms` so countdowns tick. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function slaLabel(t: Ticket, now: number) {
  const s = slaState(t, now);
  if (s.clock === 'paused') return { text: 'paused', tone: 'muted' as const, s };
  if (s.clock === 'met') return { text: formatLeft(Date.parse(t.solvedAt!) - Date.parse(t.createdAt)), tone: 'done' as const, s };
  if (t.status === 'solved') return { text: 'late', tone: 'danger' as const, s };
  return { text: formatLeft(s.left), tone: s.tone, s };
}

export function ago(iso: string, now = Date.now()) {
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const prLabel = (p: Ticket['priority']) => `P${p} · ${SLA[p].label}`;

/* ---------- Toasts ---------- */
export const ToastCtx = createContext<(text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; id: number } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3200);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <ToastCtx.Provider value={(text) => setMsg({ text, id: Date.now() })}>
      {children}
      {msg && <div className="toast" role="status" key={msg.id}>{msg.text}</div>}
    </ToastCtx.Provider>
  );
}

/* ---------- Dialog ---------- */
export function Dialog({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    const cancel = (e: Event) => { e.preventDefault(); onClose(); };
    d.addEventListener('cancel', cancel);
    return () => d.removeEventListener('cancel', cancel);
  }, [onClose]);
  return (
    <dialog ref={ref} aria-labelledby="dlg-title" onMouseDown={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="dlg">
        <h2 id="dlg-title">{title}</h2>
        {sub && <p>{sub}</p>}
        {children}
      </div>
    </dialog>
  );
}

/* ---------- Theme ---------- */
export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (document.documentElement.dataset.theme as 'dark' | 'light') || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#08080a' : '#f6f6f4');
    try { localStorage.setItem('fixline-theme', theme); } catch { /* private mode */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const;
}

/** A small burst of lime confetti when a ticket is solved. */
export function celebrate() {
  const c = document.createElement('canvas');
  c.className = 'confetti';
  c.width = innerWidth; c.height = innerHeight;
  document.body.appendChild(c);
  const g = c.getContext('2d')!;
  const bits = Array.from({ length: 70 }, () => ({
    x: innerWidth * (0.55 + Math.random() * 0.2), y: innerHeight * 0.8, vx: (Math.random() - 0.5) * 9, vy: -8 - Math.random() * 8,
    s: 4 + Math.random() * 5, r: Math.random() * 6, col: ['#c8f560', '#ffffff', '#a78bfa', '#6ea8ff'][Math.floor(Math.random() * 4)],
  }));
  let frame = 0;
  const tick = () => {
    g.clearRect(0, 0, c.width, c.height);
    for (const b of bits) { b.x += b.vx; b.y += b.vy; b.vy += 0.35; b.r += 0.1; g.save(); g.translate(b.x, b.y); g.rotate(b.r); g.fillStyle = b.col; g.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.6); g.restore(); }
    if (++frame < 90) requestAnimationFrame(tick); else c.remove();
  };
  tick();
}
