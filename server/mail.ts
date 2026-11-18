import nodemailer, { type Transporter } from 'nodemailer';
import type { Db } from './db.js';

export interface OutgoingEmail {
  workspaceId: number | null;
  to: string;
  subject: string;
  body: string;
  kind: 'created' | 'reply' | 'solved' | 'requester-reply' | 'urgent' | 'reset' | 'incident';
  ticketId?: number;
  /** what the outbox shows instead of the real body (used for password links) */
  logBody?: string;
  /** never deliver (demo desks) */
  logOnly?: boolean;
}

/**
 * Sends email through any SMTP service when SMTP_URL is set, e.g.
 * smtp://user:password@smtp.example.com:587. Without it, emails are recorded
 * in the outbox (and reset links are printed to the server log) so everything
 * works in development and in the demo without a mail account.
 * Every email, sent or not, is recorded so admins can see what went out.
 */
export class Mailer {
  private transport: Transporter | null;
  readonly delivery: 'smtp' | 'log';
  readonly from: string;

  constructor(smtpUrl = process.env.SMTP_URL, from = process.env.MAIL_FROM) {
    this.transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : null;
    this.delivery = this.transport ? 'smtp' : 'log';
    this.from = from ?? 'Fixline <helpdesk@fixline.local>';
  }

  async send(db: Db, m: OutgoingEmail): Promise<'sent' | 'logged' | 'failed'> {
    let status: 'sent' | 'logged' | 'failed' = 'logged';
    if (this.transport && !m.logOnly) {
      try {
        await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.body });
        status = 'sent';
      } catch (err) {
        console.error('Email failed', err);
        status = 'failed';
      }
    } else if (m.kind === 'reset' && !m.logOnly) {
      console.log(`\n[dev] Password reset for ${m.to}:\n${m.body}\n`);
    }
    await db.query(
      'INSERT INTO emails (workspace_id, to_email, subject, body, kind, ticket_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [m.workspaceId, m.to, m.subject, m.logBody ?? m.body, m.kind, m.ticketId ?? null, status],
    );
    return status;
  }
}

/** The ticket tag in subjects. Replies keep it, which is how an emailed reply finds its ticket. */
export const subjectTag = (key: string) => `[${key}]`;
export const findTag = (subject: string) => subject.match(/\[([A-Z]{1,6})-(\d{1,9})\]/);

/** Keeps only the new part of an emailed reply: cuts the quoted history most mail apps add. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .{4,120} wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From:\s.+/i.test(line.trim()) && out.length) break;
    if (/^_{8,}$/.test(line.trim())) break;
    if (line.includes('— Reply above this line —')) break;
    out.push(line);
  }
  return out.join('\n').trim();
}
