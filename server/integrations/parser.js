// Rule-based email triage + draft-order parsing (no external service needed).
import { db } from '../db.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function parseDate(text) {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const m = text.match(/\b(?:by|due|before|on|for)\s+(?:\w+day,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/i);
  if (!m) return null;
  const now = new Date();
  let y = m[3] ? +m[3] : now.getFullYear();
  const d = new Date(Date.UTC(y, MONTHS.indexOf(m[1].toLowerCase()), +m[2]));
  if (!m[3] && d < now - 864e5 * 30) d.setUTCFullYear(y + 1);
  return d.toISOString().slice(0, 10);
}

function matchPrice(line, prices) {
  const l = line.toLowerCase();
  let best = null, score = 0;
  for (const p of prices) {
    const words = p.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
    const hit = words.filter((w) => l.includes(w.replace(/s$/, ''))).length;
    const s = hit / (words.length || 1);
    if (hit && s > score) { best = p; score = s; }
  }
  return score >= 0.5 ? best : null;
}

export function classify({ from_email, subject, body }) {
  const text = `${subject}\n${body}`.toLowerCase();
  const prices = db.prepare('SELECT * FROM prices').all();
  const lines = body.split('\n');
  const items = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*•]?\s*(\d[\d,]*)\s*(?:x|pcs|pieces|copies)?\s+(.{3,})$/i);
    if (!m) continue;
    const p = matchPrice(m[2], prices);
    if (p) items.push({ description: p.name, qty: Number(m[1].replace(/,/g, '')), rate: p.rate, price_id: p.id });
  }
  const known = db.prepare('SELECT customer_name FROM orders WHERE lower(customer_email)=lower(?) LIMIT 1').get(from_email || '');
  const isInquiry = /\b(status|update on|where is|when will|ready yet|any news|how long|question|can you tell)\b/.test(text) || /\?\s*$/m.test(subject);
  const isOrder = items.length > 0 || /\b(place an order|new order|please print|we.d like to order|quote)\b/.test(text);

  if (items.length || isOrder) {
    return { kind: 'order', draft: {
      customer_name: known?.customer_name || '', customer_email: from_email || '', due_date: parseDate(text),
      details: body.trim().slice(0, 600), items } };
  }
  if (isInquiry) return { kind: 'inquiry', draft: { customer_name: known?.customer_name || '' } };
  return { kind: 'unclassified', draft: null };
}

const decode = (t) => t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
export const htmlToText = (h) => decode(h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ''));

/** Strip quoted replies, signatures and footers so only what the sender actually wrote is left. */
export function cleanBody(text) {
  const out = [];
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    if (/^On .{5,120}wrote:\s*$/i.test(line) || /^-{2,}\s*(Original Message|Forwarded message)/i.test(line) || /^_{5,}$/.test(line)
      || /^-- ?$/.test(line) || /^Sent from my (iPhone|iPad|Android)/i.test(line) || /^From:\s.+<.+>/.test(line) && out.length) break;
    if (line.trim().startsWith('>')) continue;
    out.push(line.trimEnd());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Promotions, newsletters and automatic mail: hidden from the queues. Never applies when order items were found. */
export function isJunk({ from_email = '', subject = '', body = '', headers = {} }) {
  if (headers['list-unsubscribe'] || /bulk|list|junk/i.test(headers.precedence || '') || /auto-(generated|replied)/i.test(headers['auto-submitted'] || '')) return true;
  if (/(^|[._-])(no-?reply|donotreply|do-not-reply|mailer-daemon|notifications?|newsletter|marketing|news)@/i.test(from_email)) return true;
  if (/\bunsubscribe\b/i.test(body) && /(view in browser|manage (your )?preferences|you are receiving this)/i.test(body)) return true;
  return /^(out of office|automatic reply|delivery status notification|undeliverable)/i.test(subject);
}

const shorten = (t, n) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t);
const firstSentences = (t, n = 170) => shorten(t.replace(/\s+/g, ' ').replace(/^(hi|hello|hey|dear)[^,.!\n]{0,40}[,!.]\s*/i, '').trim(), n);

/** One-line summary shown in the queues. */
export function summarizeEmail(kind, draft, clean, fromName) {
  if (kind === 'order' && draft?.items?.length) {
    const items = draft.items.map((i) => `${i.qty} × ${i.description}`).join(', ');
    return `${draft.customer_name || fromName || 'Customer'}: ${items}${draft.due_date ? ` · due ${draft.due_date}` : ''}`;
  }
  return firstSentences(clean) || '(empty message)';
}
