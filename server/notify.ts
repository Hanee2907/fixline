import { SLA, formatMinutes } from '../shared/sla.js';
import type { Ticket } from '../shared/types.js';
import type { Db } from './db.js';
import { subjectTag, type Mailer } from './mail.js';

/**
 * The emails Fixline sends. Each one carries the ticket tag in its subject, e.g. "[FX-1048]",
 * so a reply from any mail app lands back on the right ticket.
 */
export class Notifier {
  constructor(private db: Db, private mailer: Mailer) {}

  private async workspaceDemo(workspaceId: number) {
    const { rows } = await this.db.query<{ demo: boolean }>('SELECT demo FROM workspaces WHERE id = $1', [workspaceId]);
    return rows[0]?.demo ?? false;
  }

  private footer(url: string) {
    return `\n\n— Reply above this line —\nYou can reply to this email to add to the ticket, or open it here: ${url}\nFixline IT help desk`;
  }

  private async send(workspaceId: number, to: string, subject: string, body: string, kind: Parameters<Mailer['send']>[1]['kind'], ticketId?: number) {
    const logOnly = await this.workspaceDemo(workspaceId);
    await this.mailer.send(this.db, { workspaceId, to, subject, body, kind, ticketId, logOnly }).catch((e) => console.error('notify failed', e));
  }

  /** "We got it" to the person who asked; urgent tickets also alert every agent. */
  async created(workspaceId: number, t: Ticket, appUrl: string) {
    const first = t.requester.name.split(' ')[0];
    const within = formatMinutes(SLA[t.priority].respond / 60_000);
    await this.send(workspaceId, t.requester.email, `${subjectTag(t.key)} We got your request: ${t.subject}`,
      `Hi ${first},\n\nThanks for letting IT know. Your ticket ${t.key} is in the queue as ${t.category}, ${SLA[t.priority].label.toLowerCase()} priority. Someone will reply within ${within} of working time.${this.footer(`${appUrl}/#/t/${t.id}`)}`,
      'created', t.id);
    if (t.priority === 1) {
      const { rows } = await this.db.query<{ email: string }>(`SELECT email FROM users WHERE workspace_id = $1 AND role <> 'requester'`, [workspaceId]);
      for (const a of rows) {
        await this.send(workspaceId, a.email, `${subjectTag(t.key)} URGENT: ${t.subject}`,
          `An urgent ticket just arrived from ${t.requester.name}${t.location ? ` (${t.location})` : ''}.\n\n${t.description || t.subject}${this.footer(`${appUrl}/#/q/all/${t.id}`)}`,
          'urgent', t.id);
      }
    }
  }

  /** IT replied: the person who asked gets the message. */
  async agentReplied(workspaceId: number, t: Ticket, agentName: string, body: string, appUrl: string) {
    await this.send(workspaceId, t.requester.email, `Re: ${subjectTag(t.key)} ${t.subject}`,
      `${agentName} from IT replied:\n\n${body}${this.footer(`${appUrl}/#/t/${t.id}`)}`, 'reply', t.id);
  }

  /** Fixed: tell them, and ask whether it really is. */
  async solved(workspaceId: number, t: Ticket, resolution: string, appUrl: string) {
    await this.send(workspaceId, t.requester.email, `${subjectTag(t.key)} Fixed: ${t.subject}`,
      `Hi ${t.requester.name.split(' ')[0]},\n\nGood news: your ticket is fixed.\n\n${resolution}\n\nDid it work? Rate the fix with one click: ${appUrl}/#/t/${t.id}\nStill broken? Just reply to this email and the ticket reopens.${this.footer(`${appUrl}/#/t/${t.id}`)}`,
      'solved', t.id);
  }

  /** The person who asked replied: tell whoever is working on it (or all of IT if nobody is yet). */
  async requesterReplied(workspaceId: number, t: Ticket, body: string, appUrl: string) {
    const { rows } = t.assignee
      ? { rows: [{ email: t.assignee.email }] }
      : await this.db.query<{ email: string }>(`SELECT email FROM users WHERE workspace_id = $1 AND role <> 'requester'`, [workspaceId]);
    for (const a of rows) {
      await this.send(workspaceId, a.email, `Re: ${subjectTag(t.key)} ${t.subject}`,
        `${t.requester.name} replied:\n\n${body}${this.footer(`${appUrl}/#/q/all/${t.id}`)}`, 'requester-reply', t.id);
    }
  }
}
