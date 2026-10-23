import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, seed } from './db.js';
import { invoicePdf } from './util.js';
import * as O from './orders.js';
import * as qb from './integrations/quickbooks.js';
import { checkEmail, gmailMode } from './integrations/gmail.js';
import * as stripe from './integrations/stripe.js';
import { summarize } from './integrations/summary.js';

seed();
qb.seedMock();

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const SHOP = { name: process.env.SHOP_NAME || 'PrintFlow Print Shop' };
const SESSION_MS = 12 * 3600e3;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const err = (status, message) => Object.assign(new Error(message), { status });
const cookie = (req, n) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === n)?.[1];

function currentUser(req) {
  const t = cookie(req, 'pf_session');
  if (!t) return null;
  const s = db.prepare('SELECT u.id, u.username, s.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(t);
  if (!s || Date.now() - s.created_at > SESSION_MS) return null;
  return s;
}

const attempts = new Map(); // naive login throttle: ip -> [count, windowStart]
function throttled(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a[1] > 15 * 60e3) { attempts.set(ip, [1, Date.now()]); return false; }
  return ++a[0] > 10;
}

async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw err(413, 'Body too large'); }
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw err(400, 'Invalid JSON'); }
}

// ---- routes: [method, regex, handler(ctx)] ----
const R = [];
const route = (m, p, fn, open = false) => R.push([m, new RegExp(`^${p.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn, open]);

route('POST', '/api/login', async ({ req, res, b }) => {
  if (throttled(req.socket.remoteAddress)) throw err(429, 'Too many attempts, try again later');
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username || ''));
  const calc = scryptSync(String(b.password || ''), u?.salt || 'x', 64);
  if (!u || !timingSafeEqual(calc, Buffer.from(u.hash, 'hex'))) throw err(401, 'Wrong username or password');
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, Date.now());
  res.setHeader('Set-Cookie', `pf_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  return { username: u.username };
}, true);
route('POST', '/api/logout', ({ req, res }) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(cookie(req, 'pf_session'));
  res.setHeader('Set-Cookie', 'pf_session=; HttpOnly; Path=/; Max-Age=0');
  return { ok: true };
}, true);
route('GET', '/api/me', ({ user }) => (user ? { username: user.username, modes: modes() } : (() => { throw err(401, 'Not signed in'); })()), true);

const modes = () => ({ quickbooks: qb.qbMode, gmail: gmailMode, stripe: stripe.stripeMode, ai: !!process.env.ANTHROPIC_API_KEY });

// Orders
route('GET', '/api/orders', ({ url }) => {
  const orders = O.listOrders({ tab: url.searchParams.get('tab') || 'open', q: url.searchParams.get('q') || '' });
  const counts = { open: 0, pastdue: 0, unpaid: 0, all: 0 };
  for (const o of O.listOrders({ tab: 'all' })) {
    counts.all++; if (o.status !== 'delivered') counts.open++; if (o.past_due) counts.pastdue++; if (!o.paid) counts.unpaid++;
  }
  return { orders, counts };
});
route('POST', '/api/orders', async ({ b }) => O.createOrder(b));
route('GET', '/api/orders/:id', ({ params }) => O.getOrder(params.id) || (() => { throw err(404, 'Order not found'); })());
route('PUT', '/api/orders/:id', async ({ params, b }) => (await O.updateOrder(params.id, b)) || (() => { throw err(404, 'Order not found'); })());
route('POST', '/api/orders/:id/status', ({ params, b }) => O.setStatus(params.id, b.status));
route('POST', '/api/orders/:id/sync', async ({ params }) => O.syncInvoice(params.id));
route('GET', '/api/orders/:id/summary', async ({ params }) => {
  const o = O.getOrder(params.id); if (!o) throw err(404, 'Order not found');
  return summarize(o, o.items, o.payments);
});
route('POST', '/api/orders/:id/payments', ({ params, b }) => {
  const amount = Math.round(Number(b.amount));
  if (!(amount > 0) || !['cash', 'check', 'other'].includes(b.method)) throw err(400, 'Bad payment');
  return O.recordPayment(params.id, { method: b.method, amount, ref: b.ref || null });
});
route('POST', '/api/orders/:id/qb-demo-pay', ({ params }) => {
  const o = O.getOrder(params.id); if (!o?.qb_invoice_id) throw err(400, 'No invoice');
  qb.mockPay(o.qb_invoice_id); return { ok: true };
});

// Card reader (Stripe Terminal, beta)
route('POST', '/api/orders/:id/terminal', async ({ params }) => {
  const o = O.getOrder(params.id); if (!o) throw err(404, 'Order not found');
  const due = o.total - o.payments.reduce((s, p) => s + p.amount, 0);
  if (due <= 0) throw err(400, 'Nothing left to pay');
  return { ...(await stripe.startCardPayment(o, due)), amount: due };
});
route('GET', '/api/terminal/:pi', async ({ params, url }) => {
  const s = await stripe.paymentStatus(params.pi);
  if (s.status === 'succeeded') {
    const o = O.getOrder(url.searchParams.get('order'));
    if (o && !o.payments.some((p) => p.ref === params.pi)) O.recordPayment(o.id, { method: 'card', amount: s.amount, ref: params.pi, last4: s.last4 });
  }
  return s;
});
route('POST', '/api/orders/:id/terminal-demo-complete', ({ params, b }) => {
  if (stripe.stripeMode === 'live') throw err(400, 'Demo only');
  return O.recordPayment(params.id, { method: 'card', amount: Math.round(Number(b.amount)), ref: String(b.pi), last4: '4242' });
});

// Card payments matching
route('GET', '/api/card-payments', async () => {
  try {
    for (const c of await stripe.recentCharges()) {
      if (db.prepare('SELECT 1 FROM payments WHERE ref=?').get(c.id)) continue;
      const ord = c.order && db.prepare('SELECT id FROM orders WHERE number=?').get(c.order);
      db.prepare('INSERT INTO payments(order_id,method,amount,ref,last4,created_at) VALUES(?,?,?,?,?,?)').run(ord?.id ?? null, 'card', c.amount, c.id, c.last4, c.created.slice(0, 19).replace('T', ' '));
    }
  } catch { /* Stripe unreachable: show what we have */ }
  return db.prepare(`SELECT p.*, o.number order_number, o.customer_name FROM payments p LEFT JOIN orders o ON o.id=p.order_id
    WHERE p.method='card' ORDER BY p.id DESC`).all();
});
route('POST', '/api/card-payments/:id/match', ({ params, b }) => {
  const o = O.getOrder(b.order_id); if (!o) throw err(404, 'Order not found');
  db.prepare("UPDATE payments SET order_id=? WHERE id=? AND method='card'").run(o.id, params.id);
  return { order: O.refreshPaid(o.id) };
});
route('POST', '/api/card-payments/demo', ({ b }) => { // demo mode: simulate a card tap with no matching order
  if (stripe.stripeMode === 'live') throw err(400, 'Demo only');
  const r = db.prepare("INSERT INTO payments(order_id,method,amount,ref,last4) VALUES(NULL,'card',?,?,'4242')").run(Math.round(Number(b.amount)) || 5000, `pi_demo_loose_${Date.now()}`);
  return { id: Number(r.lastInsertRowid) };
});

route('GET', '/api/orders/:id/invoice.pdf', ({ params, res }) => {
  const o = O.getOrder(params.id); if (!o) throw err(404, 'Order not found');
  res.raw = { type: 'application/pdf', data: invoicePdf({ shop: SHOP, order: o, items: o.items }), name: `${o.number}.pdf` };
});

// QuickBooks
route('POST', '/api/quickbooks/import', async () => O.importFromQuickBooks());
route('POST', '/api/quickbooks/sync', async () => O.syncPaidFromQuickBooks());

// Email
route('POST', '/api/email/check', async () => checkEmail());
route('GET', '/api/emails', ({ url }) => {
  const kind = url.searchParams.get('kind');
  const rows = db.prepare("SELECT * FROM emails WHERE kind=? AND state='pending' ORDER BY received_at DESC").all(kind);
  return rows.map((e) => ({ ...e, draft: e.draft ? JSON.parse(e.draft) : null }));
});
route('GET', '/api/emails/counts', () => Object.fromEntries(
  ['order', 'inquiry', 'unclassified'].map((k) => [k, db.prepare("SELECT COUNT(*) c FROM emails WHERE kind=? AND state='pending'").get(k).c])));
route('POST', '/api/emails/:id/confirm', async ({ params, b }) => {
  const e = db.prepare("SELECT * FROM emails WHERE id=? AND state='pending'").get(params.id);
  if (!e) throw err(404, 'Email not in the queue');
  const order = await O.createOrder(b, { source: 'email', emailId: e.id });
  db.prepare("UPDATE emails SET state='confirmed', order_id=? WHERE id=?").run(order.id, e.id);
  return order;
});
route('POST', '/api/emails/:id/dismiss', ({ params }) => {
  db.prepare("UPDATE emails SET state='dismissed' WHERE id=?").run(params.id); return { ok: true };
});
route('POST', '/api/emails/:id/reclassify', ({ params, b }) => { // e.g. unclassified -> inquiry / order
  if (!['order', 'inquiry', 'unclassified'].includes(b.kind)) throw err(400, 'Bad kind');
  const e = db.prepare('SELECT * FROM emails WHERE id=?').get(params.id);
  const draft = e.draft || (b.kind === 'order' ? JSON.stringify({ customer_name: e.from_name, customer_email: e.from_email, details: e.body.slice(0, 600), items: [] }) : null);
  db.prepare('UPDATE emails SET kind=?, draft=? WHERE id=?').run(b.kind, draft, params.id); return { ok: true };
});

// Reconcile
route('GET', '/api/reconcile', () => ({
  no_invoice: db.prepare('SELECT * FROM orders WHERE qb_invoice_id IS NULL ORDER BY id DESC').all(),
  orphan_emails: db.prepare("SELECT id, from_name, from_email, subject, received_at, state FROM emails WHERE kind='order' AND order_id IS NULL ORDER BY received_at DESC").all(),
}));

// Prices
route('GET', '/api/prices', () => db.prepare('SELECT * FROM prices ORDER BY category, name').all());
const priceArgs = (b) => {
  const rate = Math.round(Number(b.rate));
  if (!String(b.name || '').trim() || !(rate >= 0)) throw err(400, 'Name and a valid rate are required');
  return [b.name.trim(), (b.category || 'General').trim(), (b.unit || 'each').trim(), rate, b.source === 'outsourced' ? 'outsourced' : 'in-house'];
};
route('POST', '/api/prices', ({ b }) => ({ id: Number(db.prepare('INSERT INTO prices(name,category,unit,rate,source) VALUES(?,?,?,?,?)').run(...priceArgs(b)).lastInsertRowid) }));
route('PUT', '/api/prices/:id', ({ params, b }) => { db.prepare('UPDATE prices SET name=?,category=?,unit=?,rate=?,source=? WHERE id=?').run(...priceArgs(b), params.id); return { ok: true }; });
route('DELETE', '/api/prices/:id', ({ params }) => { db.prepare('DELETE FROM prices WHERE id=?').run(params.id); return { ok: true }; });

// ---- server ----
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, data, type = 'application/json', extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const [m, re, fn, open] of R) {
        const hit = req.method === m && re.exec(url.pathname);
        if (!hit) continue;
        const user = currentUser(req);
        if (!user && !open) throw err(401, 'Not signed in');
        if (m !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site') throw err(403, 'Cross-site request blocked');
        const out = await fn({ req, res, url, user, params: hit.groups || {}, b: m === 'GET' ? {} : await body(req) });
        if (res.raw) return send(200, res.raw.data, res.raw.type, { 'Content-Disposition': `inline; filename="${res.raw.name}"` });
        return send(200, out ?? { ok: true });
      }
      throw err(404, 'Not found');
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const data = await readFile(join(PUBLIC, rel)).catch(() => null);
    if (!data) return send(404, 'Not found', 'text/plain');
    send(200, data, MIME[extname(rel)] || 'application/octet-stream');
  } catch (e) {
    send(e.status || 500, { error: e.status ? e.message : 'Server error' });
    if (!e.status) console.error(e);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PrintFlow Connect running at http://localhost:${PORT}\n  QuickBooks: ${qb.qbMode} | Gmail: ${gmailMode} | Stripe Terminal: ${stripe.stripeMode}`));

// Background jobs
setInterval(() => O.syncPaidFromQuickBooks().catch((e) => console.error('QB paid-sync failed:', e.message)), 15 * 60e3).unref();
if (gmailMode === 'live') setInterval(() => checkEmail().catch((e) => console.error('Gmail check failed:', e.message)), 2 * 60e3).unref();
db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - SESSION_MS);
