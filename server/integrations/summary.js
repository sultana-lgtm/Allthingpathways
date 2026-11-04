// "Where does this job stand" blurb. Uses Claude if ANTHROPIC_API_KEY is set; falls back to a template.
import { money, today } from '../util.js';

const STATUS = { received: 'received and waiting to start', production: 'in production', finished: 'finished and ready for pickup or delivery', delivered: 'delivered' };

export function templateSummary(o, items, payments) {
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const bits = [`${o.number} for ${o.customer_name} is ${STATUS[o.status]}.`];
  bits.push(`${items.length} line item${items.length === 1 ? '' : 's'}, total ${money(o.total)} including 6% tax.`);
  if (o.due_date && o.status !== 'delivered') {
    const days = Math.round((new Date(o.due_date) - new Date(today())) / 864e5);
    bits.push(days < 0 ? `It is ${-days} day${days === -1 ? '' : 's'} past due (${o.due_date}).` : days === 0 ? 'It is due today.' : `Due in ${days} day${days === 1 ? '' : 's'} (${o.due_date}).`);
  }
  if (o.paid) bits.push('Paid in full.');
  else if (paid) bits.push(`${money(paid)} received; ${money(o.total - paid)} still outstanding.`);
  else bits.push('Nothing paid yet.');
  if (!o.qb_invoice_id) bits.push('No QuickBooks invoice is linked yet.');
  return bits.join(' ');
}

export async function summarize(o, items, payments) {
  const fallback = templateSummary(o, items, payments);
  if (!process.env.ANTHROPIC_API_KEY) return { text: fallback, ai: false };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 200,
        messages: [{ role: 'user', content: `Write a 2-3 sentence plain-English status update for a print shop job, for staff. Today is ${today()}. Facts: ${fallback}\nItems: ${items.map((i) => `${i.qty} x ${i.description}`).join('; ')}\nDetails: ${o.details || 'none'}` }] }) });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    return { text: j.content?.[0]?.text?.trim() || fallback, ai: true };
  } catch { return { text: fallback, ai: false }; }
}
