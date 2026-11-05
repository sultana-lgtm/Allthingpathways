// Gmail adapter. Live mode reads the shop inbox via the Gmail REST API;
// demo mode releases a handful of sample emails so the review flow can be tried.
import { db, getKv, setKv } from '../db.js';
import { classify, cleanBody, htmlToText, isJunk, summarizeEmail } from './parser.js';

// Connected via the in-app "Connect Gmail" flow (token kept in the database) or GMAIL_* env vars.
const clientId = () => process.env.GMAIL_CLIENT_ID;
const clientSecret = () => process.env.GMAIL_CLIENT_SECRET;
const refreshTok = () => getKv('gmail_refresh') || process.env.GMAIL_REFRESH_TOKEN;
export const appConfigured = () => !!(clientId() && clientSecret());
const isLive = () => !!(appConfigured() && refreshTok());
export const gmailMode = () => (isLive() ? 'live' : 'demo');

const SAMPLES = [
  { id: 'demo-1', from: 'Dana Whitfield <dana@whitfieldrealty.example>', subject: 'Order: open house materials',
    body: 'Hi,\n\nPlease print the following for our open house, needed by Nov 14:\n\n- 500 flyers 8.5x11\n- 2 yard signs\n- 5 business cards\n\nThanks,\nDana' },
  { id: 'demo-2', from: 'Harbor Fitness <hello@harborfitness.example>', subject: 'New order - spring promo',
    body: 'Hello team,\nWe would like to order:\n250 brochures tri-fold\n4 posters 18x24\nDue by 2026-11-20 please.\n\nHarbor Fitness' },
  { id: 'demo-3', from: 'Riverside Dental <office@riversidedental.example>', subject: 'Status of our posters?',
    body: 'Hi, can you tell me when our posters will be ready? Just checking in on the status.' },
  { id: 'demo-4', from: 'Sam <sam.k@randommail.example>', subject: 'Hey',
    body: 'Saw your shop on the corner. Do you also do photography?' },
  { id: 'demo-5', from: 'Print Trade Weekly <news@printtradeweekly.example>', subject: 'This week: 40% off paper stock!',
    body: 'Big savings on paper stock.\n\nView in browser | Manage preferences\nYou are receiving this because you subscribed. Unsubscribe anytime.',
    headers: { 'list-unsubscribe': '<mailto:unsub@printtradeweekly.example>' } },
];

const parseFrom = (f) => {
  const m = f.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: f.trim() };
};

let tok = { v: null, exp: 0 };
async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }) });
  if (!r.ok) throw new Error(`Gmail auth failed (${r.status}). Try reconnecting Gmail in Settings.`);
  return r.json();
}
async function gtoken() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const j = await tokenRequest({ refresh_token: refreshTok(), grant_type: 'refresh_token' });
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return tok.v;
}

export function authorizeUrl(redirectUri, state) {
  if (!appConfigured()) throw new Error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first');
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId(), redirect_uri: redirectUri, response_type: 'code', state,
    scope: 'https://www.googleapis.com/auth/gmail.readonly', access_type: 'offline', prompt: 'consent' });
}

/** Finish Google sign-in; drop unconfirmed demo emails so the queue only holds real mail. */
export async function completeConnect(code, redirectUri) {
  const j = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!j.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  setKv('gmail_refresh', j.refresh_token);
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  db.prepare("DELETE FROM emails WHERE gmail_id LIKE 'demo-%' AND order_id IS NULL").run();
}
export function disconnect() { db.prepare("DELETE FROM kv WHERE k='gmail_refresh'").run(); tok = { v: null, exp: 0 }; }
export async function accountEmail() { return (await g('profile')).emailAddress; }
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
  const html = (p) => {
    if (p.mimeType === 'text/html' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
    for (const c of p.parts || []) { const t = html(c); if (t) return t; }
    return '';
  };
  return walk(payload) || htmlToText(html(payload));
}

async function fetchLive() {
  const list = await g(`messages?q=${encodeURIComponent(process.env.GMAIL_QUERY || 'in:inbox newer_than:14d -category:promotions -category:social -category:forums')}&maxResults=25`);
  const out = [];
  for (const { id } of list.messages || []) {
    if (db.prepare('SELECT 1 FROM emails WHERE gmail_id=?').get(id)) continue;
    const m = await g(`messages/${id}?format=full`);
    const h = (n) => m.payload.headers.find((x) => x.name.toLowerCase() === n)?.value || '';
    out.push({ id, thread: m.threadId, from: h('from'), subject: h('subject'), body: bodyText(m.payload) || m.snippet,
      headers: { 'list-unsubscribe': h('list-unsubscribe'), precedence: h('precedence'), 'auto-submitted': h('auto-submitted') },
      date: new Date(+m.internalDate).toISOString() });
  }
  return out;
}

/** Shorter AI summary when an Anthropic key is set; otherwise the rule-based one is used. */
async function aiSummary(subject, clean, fallback) {
  if (!process.env.ANTHROPIC_API_KEY) return fallback;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 100,
        messages: [{ role: 'user', content: `Summarize this email to a print shop in ONE short line (max 25 words): what the customer wants, quantities, and any deadline. No greeting.\n\nSubject: ${subject}\n\n${clean.slice(0, 3000)}` }] }) });
    if (!r.ok) return fallback;
    return (await r.json()).content?.[0]?.text?.trim() || fallback;
  } catch { return fallback; }
}

/** Fill in the clean text / summary for stored mail that has none yet, and hide junk. Safe to run repeatedly. */
export async function reprocess() {
  const rows = db.prepare("SELECT * FROM emails WHERE summary IS NULL AND state='pending'").all();
  for (const e of rows) {
    const clean = cleanBody(e.body);
    const draft = e.draft ? JSON.parse(e.draft) : null;
    const hasItems = !!draft?.items?.length;
    if (!hasItems && isJunk({ from_email: e.from_email, subject: e.subject, body: e.body })) {
      db.prepare("UPDATE emails SET kind='junk', state='dismissed', clean=?, summary='' WHERE id=?").run(clean, e.id);
      continue;
    }
    const base = summarizeEmail(e.kind, draft, clean, e.from_name);
    const summary = hasItems ? base : await aiSummary(e.subject, clean, base);
    db.prepare('UPDATE emails SET clean=?, summary=? WHERE id=?').run(clean, summary, e.id);
  }
}

/** Pull new mail, classify each message, queue it. Returns counts. */
export async function checkEmail() {
  const incoming = isLive() ? await fetchLive() : SAMPLES.filter((s) => !db.prepare('SELECT 1 FROM emails WHERE gmail_id=?').get(s.id));
  const counts = { order: 0, inquiry: 0, unclassified: 0, junk: 0 };
  const ins = db.prepare(`INSERT OR IGNORE INTO emails(gmail_id,thread_id,from_name,from_email,subject,body,received_at,kind,draft,state)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (const e of incoming) {
    const f = parseFrom(e.from);
    const clean = cleanBody(e.body);
    const c = classify({ from_email: f.email, subject: e.subject, body: clean || e.body });
    if (!c.draft?.items?.length && isJunk({ from_email: f.email, subject: e.subject, body: e.body, headers: e.headers })) { c.kind = 'junk'; c.draft = null; }
    if (c.draft && c.kind === 'order' && !c.draft.customer_name) c.draft.customer_name = f.name;
    ins.run(e.id, e.thread || e.id, f.name, f.email, e.subject, e.body, e.date || new Date().toISOString(),
      c.kind, c.draft ? JSON.stringify(c.draft) : null, c.kind === 'junk' ? 'dismissed' : 'pending');
    if (c.kind === 'junk') counts.junk++; else counts[c.kind]++;
  }
  await reprocess();
  return counts;
}
