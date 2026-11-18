import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { searchTerms } from '../../shared/classify.js';
import type { Db } from '../db.js';
import { getTicket, listMessages } from '../repo.js';
import type { Module } from './index.js';

/**
 * The AI assistant, grounded in this desk's own knowledge base and tickets.
 * It only switches on when the server has ANTHROPIC_API_KEY set, so nothing is
 * sent anywhere (or billed) unless the desk's owner chooses to.
 *
 * - Summaries: what's wrong, what's been tried, what to do next.
 * - Reply drafts: written for the person, using the desk's own guides. IT always reviews before sending.
 * - Ask: employees get an answer from the guides, with the guides it came from, or a nudge to open a ticket.
 */
const MODEL = 'claude-opus-5-5';

// Stable instructions go first and are cached; each request's ticket or question comes after.
const SYSTEM = `You are the assistant inside Fixline, an IT help desk.
Be accurate, brief and kind. Write plain English for people who aren't technical.
Only state fixes that appear in the provided guides or ticket history; if you're not sure, say so.
Never invent ticket numbers, names, links or policies. Never ask for or repeat passwords.`;

let client: Anthropic | null | undefined;
/** Overridable in tests. */
export function setAiClient(c: Anthropic | null) { client = c; }
const ai = () => (client === undefined ? (client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null) : client);

async function complete(task: string, input: string, maxTokens = 2000): Promise<string> {
  const c = ai();
  if (!c) throw new Error('AI is not configured');
  const response = await c.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    // Quick help-desk answers don't need deep reasoning; low effort keeps them fast and cheap.
    output_config: { effort: 'low' },
    // If a request is declined by the safety system, retry on a suitable fallback model automatically.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `${task}\n\n${input}` }],
  });
  if (response.stop_reason === 'refusal') return 'I can’t help with that one. Please ask a person on the IT team.';
  return response.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
}

/** The guides most related to some text, by PostgreSQL full-text search. */
async function relatedGuides(db: Db, ws: number, text: string, limit = 5) {
  const terms = searchTerms(text);
  if (!terms.length) return [];
  const { rows } = await db.query<{ id: number; title: string; body: string }>(
    `SELECT id, title, body FROM articles WHERE workspace_id = $1 AND to_tsvector('english', title || ' ' || body) @@ to_tsquery('english', $2)
      ORDER BY ts_rank(to_tsvector('english', title || ' ' || body), to_tsquery('english', $2)) DESC, uses DESC LIMIT $3`,
    [ws, terms.map((t) => t.replace(/'/g, '')).join(' | '), limit],
  );
  return rows;
}

const guidesBlock = (guides: { id: number; title: string; body: string }[]) =>
  guides.length ? guides.map((g) => `<guide id="${g.id}" title="${g.title.replace(/"/g, "'")}">\n${g.body}\n</guide>`).join('\n') : '<no_guides/>';

export const aiModule: Module = {
  private(app, ctx) {
    const { db } = ctx;
    const perUser = ctx.rateLimit(30, 60 * 60_000);
    const fail = (e: unknown) => {
      console.error('AI request failed', e);
      return e instanceof Anthropic.RateLimitError ? 'The AI is busy right now. Try again in a minute.' : 'The AI couldn’t answer just now. Try again in a moment.';
    };

    app.get('/api/ai/status', (c) => c.json({ enabled: !!ai(), model: ai() ? MODEL : null }));

    app.post('/api/ai/tickets/:id/summary', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      if (!ai()) return c.json({ error: 'AI is off. Set ANTHROPIC_API_KEY on the server to turn it on.' }, 503);
      if (!perUser(`ai:${u.id}`)) return c.json({ error: 'That’s a lot of assistant requests for one hour. Try again later.' }, 429);
      const t = await getTicket(db, u.workspaceId, ctx.idOf(c));
      if (!t) return c.json({ error: 'Not found' }, 404);
      const msgs = await listMessages(db, t.id, true);
      const history = msgs.map((m) => `[${m.kind}${m.author ? ` by ${m.author.name}` : ''}] ${m.body}`).join('\n');
      try {
        const summary = await complete(
          'Summarise this help desk ticket for an IT agent who is picking it up. Use exactly three short bullet points: "Problem:", "Tried so far:", "Next step:". No other text.',
          `<ticket key="${t.key}" category="${t.category}" priority="P${t.priority}" status="${t.status}">\nSubject: ${t.subject}\nFrom: ${t.requester.name} (${t.requester.department || 'no team'})\n${t.description}\n</ticket>\n<history>\n${history}\n</history>`,
          800,
        );
        return c.json({ summary });
      } catch (e) {
        return c.json({ error: fail(e) }, 502);
      }
    });

    app.post('/api/ai/tickets/:id/draft', ctx.agentOnly, async (c) => {
      const u = c.get('user');
      if (!ai()) return c.json({ error: 'AI is off. Set ANTHROPIC_API_KEY on the server to turn it on.' }, 503);
      if (!perUser(`ai:${u.id}`)) return c.json({ error: 'That’s a lot of assistant requests for one hour. Try again later.' }, 429);
      const p = z.object({ instruction: z.string().trim().max(300).default('') }).safeParse((await ctx.body(c)) ?? {});
      const t = await getTicket(db, u.workspaceId, ctx.idOf(c));
      if (!t) return c.json({ error: 'Not found' }, 404);
      const msgs = await listMessages(db, t.id, false); // only what the person can see: drafts never leak internal notes
      const guides = await relatedGuides(db, u.workspaceId, `${t.subject} ${t.description}`, 3);
      try {
        const draft = await complete(
          `Draft the next reply from ${u.name} (IT) to ${t.requester.name.split(' ')[0]}. Use the guides if one fits, as numbered steps. Keep it under 120 words, friendly, no sign-off line. Output only the reply text.${p.success && p.data.instruction ? `\nThe agent asks: ${p.data.instruction}` : ''}`,
          `<ticket>\nSubject: ${t.subject}\n${t.description}\n</ticket>\n<conversation>\n${msgs.filter((m) => m.kind === 'reply').map((m) => `${m.author?.name ?? 'Someone'}: ${m.body}`).join('\n')}\n</conversation>\n<guides>\n${guidesBlock(guides)}\n</guides>`,
          1200,
        );
        return c.json({ draft, guides: guides.map((g) => ({ id: g.id, title: g.title })) });
      } catch (e) {
        return c.json({ error: fail(e) }, 502);
      }
    });

    /** Employees ask in their own words; the answer only uses the desk's guides, and says which ones. */
    app.post('/api/ai/ask', async (c) => {
      const u = c.get('user');
      if (!ai()) return c.json({ error: 'AI is off on this desk.' }, 503);
      if (!perUser(`ai:${u.id}`)) return c.json({ error: 'That’s a lot of questions for one hour. Try again later.' }, 429);
      const p = z.object({ question: z.string().trim().min(4, 'Ask a question').max(500) }).safeParse(await ctx.body(c));
      if (!p.success) return c.json(ctx.firstError(p.error), 400);
      const guides = await relatedGuides(db, u.workspaceId, p.data.question);
      if (!guides.length) return c.json({ answer: null, sources: [], suggestTicket: true });
      try {
        const raw = await complete(
          `Answer the employee's question using ONLY the guides below, as short numbered steps. After the answer, on its own last line, write "SOURCES:" followed by the ids of the guides you used, comma-separated. If the guides don't answer it, reply exactly "NO_ANSWER".`,
          `<question>${p.data.question}</question>\n<guides>\n${guidesBlock(guides)}\n</guides>`,
          1200,
        );
        if (/^NO_ANSWER/.test(raw)) return c.json({ answer: null, sources: [], suggestTicket: true });
        const m = raw.match(/\n?SOURCES:\s*([\d,\s]+)\s*$/);
        const ids = m ? m[1].split(',').map((x) => Number(x.trim())).filter(Boolean) : [];
        const sources = guides.filter((g) => ids.includes(g.id)).map((g) => ({ id: g.id, title: g.title }));
        return c.json({ answer: raw.replace(/\n?SOURCES:[\s\S]*$/, '').trim(), sources, suggestTicket: false });
      } catch (e) {
        return c.json({ error: fail(e) }, 502);
      }
    });
  },
};

export { aiModule as ai };
