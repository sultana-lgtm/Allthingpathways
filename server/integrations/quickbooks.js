// QuickBooks Online adapter. Uses the live API when QBO_* env vars are set,
// otherwise a local sandbox (stored in SQLite) so the whole app works offline.
import { db } from '../db.js';
import { TAX_RATE } from '../util.js';

const live = !!(process.env.QBO_REALM_ID && process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET && process.env.QBO_REFRESH_TOKEN);
export const qbMode = live ? 'live' : 'demo';

let token = { value: null, exp: 0 };
let refreshToken = process.env.QBO_REFRESH_TOKEN;

async function accessToken() {
  if (token.value && Date.now() < token.exp) return token.value;
  const r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!r.ok) throw new Error(`QuickBooks auth failed (${r.status})`);
  const j = await r.json();
  refreshToken = j.refresh_token || refreshToken; // Intuit rotates refresh tokens
  token = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return token.value;
}

async function qbo(path, { method = 'GET', body } = {}) {
  const base = process.env.QBO_SANDBOX === '1' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
  const r = await fetch(`${base}/v3/company/${process.env.QBO_REALM_ID}/${path}`, {
    method, headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`QuickBooks ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
const query = (q) => qbo(`query?minorversion=70&query=${encodeURIComponent(q)}`).then((j) => j.QueryResponse);
const cents = (d) => Math.round(Number(d) * 100);
const dollars = (c) => Math.round(c) / 100;

async function customerRef(name, email) {
  const safe = name.replace(/'/g, "\\'");
  const found = (await query(`select Id from Customer where DisplayName = '${safe}'`)).Customer?.[0];
  if (found) return { value: found.Id };
  const c = await qbo('customer?minorversion=70', {
    method: 'POST', body: { DisplayName: name, ...(email ? { PrimaryEmailAddr: { Address: email } } : {}) } });
  return { value: c.Customer.Id };
}

function liveLines(items, tax) {
  const item = { value: process.env.QBO_ITEM_ID || '1' };
  const lines = items.map((i) => ({
    DetailType: 'SalesItemLineDetail', Description: i.description,
    Amount: dollars(Math.round(i.qty * i.rate)),
    SalesItemLineDetail: { ItemRef: item, Qty: i.qty, UnitPrice: dollars(i.rate) },
  }));
  lines.push({ DetailType: 'SalesItemLineDetail', Description: `Sales tax (${TAX_RATE * 100}%)`, Amount: dollars(tax),
    SalesItemLineDetail: { ItemRef: item, Qty: 1, UnitPrice: dollars(tax) } });
  return lines;
}

let mockSeq = 1100;

export async function createInvoice(order, items) {
  if (live) {
    const j = await qbo('invoice?minorversion=70', { method: 'POST', body: {
      CustomerRef: await customerRef(order.customer_name, order.customer_email),
      DocNumber: order.number, DueDate: order.due_date || undefined, Line: liveLines(items, order.tax) } });
    return { id: j.Invoice.Id, balance: cents(j.Invoice.Balance) };
  }
  const id = String(++mockSeq);
  db.prepare('INSERT INTO qb_mock_invoices VALUES(?,?,?,?,?,?,?)').run(id, order.customer_name, order.customer_email || '',
    new Date().toISOString().slice(0, 10), order.total, order.total, JSON.stringify(items));
  return { id, balance: order.total };
}

export async function updateInvoice(id, order, items) {
  if (live) {
    const cur = (await qbo(`invoice/${id}?minorversion=70`)).Invoice;
    const j = await qbo('invoice?minorversion=70', { method: 'POST', body: {
      Id: id, SyncToken: cur.SyncToken, sparse: true, Line: liveLines(items, order.tax) } });
    return { id, balance: cents(j.Invoice.Balance) };
  }
  const row = db.prepare('SELECT * FROM qb_mock_invoices WHERE id=?').get(id);
  if (!row) throw new Error('Invoice not found in QuickBooks');
  const paid = row.total - row.balance;
  db.prepare('UPDATE qb_mock_invoices SET total=?, balance=?, lines=? WHERE id=?')
    .run(order.total, Math.max(0, order.total - paid), JSON.stringify(items), id);
  return { id, balance: Math.max(0, order.total - paid) };
}

export async function getInvoice(id) {
  if (live) {
    const j = (await qbo(`invoice/${id}?minorversion=70`)).Invoice;
    return { id, balance: cents(j.Balance), total: cents(j.TotalAmt) };
  }
  const r = db.prepare('SELECT * FROM qb_mock_invoices WHERE id=?').get(id);
  return r ? { id, balance: r.balance, total: r.total } : null;
}

export async function listInvoices() {
  if (live) {
    const out = []; let start = 1;
    for (;;) {
      const r = await query(`select * from Invoice orderby TxnDate desc startposition ${start} maxresults 100`);
      const page = r.Invoice || [];
      for (const i of page) out.push({
        id: i.Id, customer: i.CustomerRef?.name || 'Unknown', email: i.BillEmail?.Address || '', date: i.TxnDate,
        total: cents(i.TotalAmt), balance: cents(i.Balance), number: i.DocNumber,
        lines: (i.Line || []).filter((l) => l.DetailType === 'SalesItemLineDetail' && !/^Sales tax/i.test(l.Description || ''))
          .map((l) => ({ description: l.Description || l.SalesItemLineDetail?.ItemRef?.name || 'Item',
            qty: l.SalesItemLineDetail?.Qty || 1, rate: cents(l.SalesItemLineDetail?.UnitPrice ?? l.Amount) })) });
      if (page.length < 100) return out;
      start += 100;
    }
  }
  return db.prepare('SELECT * FROM qb_mock_invoices ORDER BY date DESC').all()
    .map((r) => ({ ...r, lines: JSON.parse(r.lines || '[]') }));
}

/** Demo only: simulate the customer paying the invoice inside QuickBooks. */
export function mockPay(id) {
  if (live) throw new Error('Only available in demo mode');
  db.prepare('UPDATE qb_mock_invoices SET balance=0 WHERE id=?').run(id);
}

export function seedMock() {
  if (live || db.prepare('SELECT COUNT(*) c FROM qb_mock_invoices').get().c) return;
  const ins = db.prepare('INSERT INTO qb_mock_invoices VALUES(?,?,?,?,?,?,?)');
  const mk = (id, customer, email, date, lines, paid) => {
    const sub = lines.reduce((s, l) => s + Math.round(l.qty * l.rate), 0);
    const total = sub + Math.round(sub * TAX_RATE);
    ins.run(id, customer, email, date, total, paid ? 0 : total, JSON.stringify(lines));
  };
  mk('1001', 'Maple Street Bakery', 'orders@maplestreetbakery.example', '2026-08-14', [{ description: 'Flyers 8.5x11', qty: 500, rate: 45 }], true);
  mk('1002', 'Riverside Dental', 'office@riversidedental.example', '2026-09-02', [{ description: 'Business cards (full colour)', qty: 5, rate: 1800 }, { description: 'Posters 18x24', qty: 4, rate: 1400 }], true);
  mk('1003', 'Harbor Fitness', 'hello@harborfitness.example', '2026-09-30', [{ description: 'Vinyl banner 3x6', qty: 2, rate: 8500 }], false);
}
