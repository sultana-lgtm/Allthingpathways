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
