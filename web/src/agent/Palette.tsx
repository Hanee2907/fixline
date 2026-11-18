import { useEffect, useMemo, useState } from 'react';
import type { Article, Ticket } from '../../../shared/types';
import { api } from '../api';

interface Item { key: string; group: string; label: string; hint?: string; run: () => void }

/** Ctrl+K: search tickets and guides, or jump anywhere, without touching the mouse. */
export function Palette({ onClose, onNew }: { onClose: () => void; onNew: () => void }) {
  const [q, setQ] = useState('');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const t = setTimeout(async () => {
      const [a, b] = await Promise.all([api.tickets('all', q).catch(() => ({ tickets: [] })), api.articles(q).catch(() => ({ articles: [] }))]);
      const solved = q ? await api.tickets('solved', q).catch(() => ({ tickets: [] })) : { tickets: [] };
      setTickets([...a.tickets, ...solved.tickets].slice(0, 6));
      setArticles(b.articles.slice(0, 4));
      setIndex(0);
    }, 120);
    return () => clearTimeout(t);
  }, [q]);

  const go = (hash: string) => () => { location.hash = hash; onClose(); };
  const items: Item[] = useMemo(() => {
    const nav: Item[] = [
      { key: 'new', group: 'Actions', label: 'New ticket', hint: 'C', run: onNew },
      { key: 'mine', group: 'Actions', label: 'Go to my tickets', run: go('/q/mine') },
      { key: 'breach', group: 'Actions', label: 'Go to breaching soon', run: go('/q/breaching') },
      { key: 'kb', group: 'Actions', label: 'Open knowledge base', run: go('/kb') },
      { key: 'rep', group: 'Actions', label: 'Open reports', run: go('/reports') },
      { key: 'inc', group: 'Actions', label: 'Declare an incident', run: go('/incidents') },
    ].filter((i) => !q || i.label.toLowerCase().includes(q.toLowerCase()));
    return [
      ...tickets.map((t) => ({ key: `t${t.id}`, group: 'Tickets', label: `${t.key} · ${t.subject}`, hint: t.requester.name, run: go(`/q/${t.status === 'solved' ? 'solved' : 'all'}/${t.id}`) })),
      ...articles.map((a) => ({ key: `a${a.id}`, group: 'Knowledge base', label: a.title, hint: a.category, run: go(`/kb/${a.id}`) })),
      ...nav,
    ];
  }, [tickets, articles, q, onNew]);

  return (
    <div className="palette" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label="Search and commands">
        <input autoFocus placeholder="Search tickets, people, guides… or type a command" value={q} onChange={(e) => setQ(e.target.value)}
          aria-label="Search" aria-activedescendant={items[index] ? `pi-${items[index].key}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(items.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') items[index]?.run();
          }} />
        <ul role="listbox">
          {items.map((it, i) => (
            <li key={it.key}>
              {(i === 0 || items[i - 1].group !== it.group) && <div className="grp">{it.group}</div>}
              <button id={`pi-${it.key}`} role="option" aria-selected={i === index} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={it.run}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>{it.hint && <small>{it.hint}</small>}
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="empty">Nothing matches “{q}”.</li>}
        </ul>
      </div>
    </div>
  );
}
