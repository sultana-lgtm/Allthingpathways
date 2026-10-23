// Gmail adapter. Live mode reads the shop inbox via the Gmail REST API;
// demo mode releases a handful of sample emails so the review flow can be tried.
import { db } from '../db.js';
import { classify } from './parser.js';

const live = !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
export const gmailMode = live ? 'live' : 'demo';

const SAMPLES = [
  { id: 'demo-1', from: 'Dana Whitfield <dana@whitfieldrealty.example>', subject: 'Order: open house materials',
    body: 'Hi,\n\nPlease print the following for our open house, needed by Nov 14:\n\n- 500 flyers 8.5x11\n- 2 yard signs\n- 5 business cards\n\nThanks,\nDana' },
  { id: 'demo-2', from: 'Harbor Fitness <hello@harborfitness.example>', subject: 'New order - spring promo',
    body: 'Hello team,\nWe would like to order:\n250 brochures tri-fold\n4 posters 18x24\nDue by 2026-11-20 please.\n\nHarbor Fitness' },
  { id: 'demo-3', from: 'Riverside Dental <office@riversidedental.example>', subject: 'Status of our posters?',
    body: 'Hi, can you tell me when our posters will be ready? Just checking in on the status.' },
  { id: 'demo-4', from: 'Sam <sam.k@randommail.example>', subject: 'Hey',
    body: 'Saw your shop on the corner. Do you also do photography?' },
];

const parseFrom = (f) => {
  const m = f.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: f.trim() };
};

let tok = { v: null, exp: 0 };
async function gtoken() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  if (!r.ok) throw new Error(`Gmail auth failed (${r.status})`);
  const j = await r.json();
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return tok.v;
}
const g = async (path) => {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${await gtoken()}` } });
  if (!r.ok) throw new Error(`Gmail ${r.status}`);
  return r.json();
};

function bodyText(payload) {
  const walk = (p) => {
    if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
    for (const c of p.parts || []) { const t = walk(c); if (t) return t; }
    return '';
  };
  return walk(payload);
}

async function fetchLive() {
  const list = await g(`messages?q=${encodeURIComponent(process.env.GMAIL_QUERY || 'in:inbox newer_than:14d -category:promotions')}&maxResults=25`);
  const out = [];
  for (const { id } of list.messages || []) {
    if (db.prepare('SELECT 1 FROM emails WHERE gmail_id=?').get(id)) continue;
    const m = await g(`messages/${id}?format=full`);
    const h = (n) => m.payload.headers.find((x) => x.name.toLowerCase() === n)?.value || '';
    out.push({ id, thread: m.threadId, from: h('from'), subject: h('subject'), body: bodyText(m.payload) || m.snippet,
      date: new Date(+m.internalDate).toISOString() });
  }
  return out;
}

/** Pull new mail, classify each message, queue it. Returns counts. */
export async function checkEmail() {
  const incoming = live ? await fetchLive() : SAMPLES.filter((s) => !db.prepare('SELECT 1 FROM emails WHERE gmail_id=?').get(s.id));
  const counts = { order: 0, inquiry: 0, unclassified: 0 };
  const ins = db.prepare(`INSERT OR IGNORE INTO emails(gmail_id,thread_id,from_name,from_email,subject,body,received_at,kind,draft)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const e of incoming) {
    const f = parseFrom(e.from);
    const c = classify({ from_email: f.email, subject: e.subject, body: e.body });
    if (c.draft && c.kind === 'order' && !c.draft.customer_name) c.draft.customer_name = f.name;
    ins.run(e.id, e.thread || e.id, f.name, f.email, e.subject, e.body, e.date || new Date().toISOString(),
      c.kind, c.draft ? JSON.stringify(c.draft) : null);
    counts[c.kind]++;
  }
  return counts;
}
