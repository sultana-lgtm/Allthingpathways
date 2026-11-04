import { db, tx } from './db.js';
import { totals, today } from './util.js';
import * as qb from './integrations/quickbooks.js';

export const STATUSES = ['received', 'production', 'finished', 'delivered'];

export function getOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return null;
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(id);
  o.payments = db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY id').all(id);
  o.past_due = !!o.due_date && o.status !== 'delivered' && o.due_date < today();
  return o;
}

export function listOrders({ tab = 'open', q = '' } = {}) {
  let rows = db.prepare('SELECT * FROM orders ORDER BY COALESCE(due_date,\'9999\'), id DESC').all();
  const t = today();
  if (tab === 'open') rows = rows.filter((o) => o.status !== 'delivered');
  else if (tab === 'pastdue') rows = rows.filter((o) => o.status !== 'delivered' && o.due_date && o.due_date < t);
  else if (tab === 'unpaid') rows = rows.filter((o) => !o.paid);
  const needle = q.trim().toLowerCase();
  if (needle) {
    const itemText = new Map();
    for (const i of db.prepare('SELECT order_id, description FROM order_items').all())
      itemText.set(i.order_id, (itemText.get(i.order_id) || '') + ' ' + i.description);
    rows = rows.filter((o) => `${o.number} ${o.customer_name} ${o.customer_email} ${o.details} ${itemText.get(o.id) || ''}`.toLowerCase().includes(needle));
  }
  return rows.map((o) => ({ ...o, past_due: o.status !== 'delivered' && !!o.due_date && o.due_date < t }));
}

function nextNumber() {
  const n = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(number,4) AS INTEGER)),1000)+1 n FROM orders WHERE number LIKE 'PF-%'").get().n;
  return `PF-${n}`;
}

function cleanItems(items) {
  return (items || []).map((i) => ({
    description: String(i.description || '').trim(), qty: Number(i.qty), rate: Math.round(Number(i.rate)), price_id: i.price_id || null }))
    .filter((i) => i.description && i.qty > 0 && Number.isFinite(i.rate) && i.rate >= 0);
}

function writeItems(orderId, items) {
  db.prepare('DELETE FROM order_items WHERE order_id=?').run(orderId);
  const ins = db.prepare('INSERT INTO order_items(order_id,description,qty,rate,price_id) VALUES(?,?,?,?,?)');
  items.forEach((i) => ins.run(orderId, i.description, i.qty, i.rate, i.price_id));
  const t = totals(items);
  db.prepare('UPDATE orders SET subtotal=?, tax=?, total=? WHERE id=?').run(t.subtotal, t.tax, t.total, orderId);
}

export async function createOrder(d, { source = 'manual', emailId = null, skipInvoice = false } = {}) {
  const items = cleanItems(d.items);
  if (!String(d.customer_name || '').trim()) throw Object.assign(new Error('Customer name is required'), { status: 400 });
  if (!items.length) throw Object.assign(new Error('Add at least one line item'), { status: 400 });
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO orders(number,customer_name,customer_email,customer_phone,due_date,details,source,email_id,status,paid)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(nextNumber(), d.customer_name.trim(), d.customer_email || '', d.customer_phone || '',
      d.due_date || null, d.details || '', source, emailId, d.status || 'received', d.paid ? 1 : 0);
    writeItems(r.lastInsertRowid, items);
    return Number(r.lastInsertRowid);
  });
  if (!skipInvoice) await syncInvoice(id);
  return getOrder(id);
}

/** Create (or refresh) the QuickBooks invoice for an order. Never throws; records the error on the order. */
export async function syncInvoice(id) {
  const o = getOrder(id);
  try {
    const r = o.qb_invoice_id ? await qb.updateInvoice(o.qb_invoice_id, o, o.items) : await qb.createInvoice(o, o.items);
    db.prepare("UPDATE orders SET qb_invoice_id=?, qb_balance=?, qb_error=NULL, qb_synced_at=datetime('now') WHERE id=?").run(r.id, r.balance, id);
  } catch (e) {
    db.prepare('UPDATE orders SET qb_error=? WHERE id=?').run(String(e.message).slice(0, 300), id);
  }
  return getOrder(id);
}

export async function updateOrder(id, d) {
  const o = getOrder(id);
  if (!o) return null;
  tx(() => {
    db.prepare('UPDATE orders SET customer_name=?, customer_email=?, customer_phone=?, due_date=?, details=? WHERE id=?').run(
      d.customer_name ?? o.customer_name, d.customer_email ?? o.customer_email, d.customer_phone ?? o.customer_phone,
      d.due_date === undefined ? o.due_date : d.due_date || null, d.details ?? o.details, id);
    if (d.items) {
      const items = cleanItems(d.items);
      if (!items.length) throw Object.assign(new Error('Add at least one line item'), { status: 400 });
      writeItems(id, items);
    }
  });
  if (d.items) await syncInvoice(id);
  return getOrder(id);
}

export function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw Object.assign(new Error('Bad status'), { status: 400 });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, id);
  return getOrder(id);
}

export function refreshPaid(id) {
  const o = getOrder(id);
  const sum = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=?').get(id).s;
  if (sum >= o.total) db.prepare('UPDATE orders SET paid=1 WHERE id=?').run(id);
  return getOrder(id);
}

export function recordPayment(id, { method, amount, ref = null, last4 = null }) {
  db.prepare('INSERT INTO payments(order_id,method,amount,ref,last4) VALUES(?,?,?,?,?)').run(id, method, amount, ref, last4);
  return refreshPaid(id);
}

/** Every 15 minutes: flip orders to paid once the QuickBooks invoice balance hits zero. */
export async function syncPaidFromQuickBooks() {
  const open = db.prepare('SELECT * FROM orders WHERE qb_invoice_id IS NOT NULL AND paid=0').all();
  let flipped = 0, failed = 0;
  for (const o of open) {
    try {
      const inv = await qb.getInvoice(o.qb_invoice_id);
      if (!inv) continue;
      db.prepare("UPDATE orders SET qb_balance=?, qb_synced_at=datetime('now') WHERE id=?").run(inv.balance, o.id);
      if (inv.balance === 0 && o.total > 0) {
        const have = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=?').get(o.id).s;
        if (have < o.total) db.prepare('INSERT INTO payments(order_id,method,amount,ref) VALUES(?,?,?,?)').run(o.id, 'quickbooks', o.total - have, o.qb_invoice_id);
        db.prepare('UPDATE orders SET paid=1 WHERE id=?').run(o.id);
        flipped++;
      }
    } catch { failed++; }
  }
  return { checked: open.length, flipped, failed };
}

export async function importFromQuickBooks() {
  const known = new Set(db.prepare('SELECT qb_invoice_id FROM orders WHERE qb_invoice_id IS NOT NULL').all().map((r) => r.qb_invoice_id));
  let imported = 0, skipped = 0;
  for (const inv of await qb.listInvoices()) {
    if (known.has(inv.id) || !inv.lines.length) { skipped++; continue; }
    const o = await createOrder({ customer_name: inv.customer, customer_email: inv.email, details: `Imported from QuickBooks invoice ${inv.number || inv.id}`,
      items: inv.lines, status: inv.balance === 0 ? 'delivered' : 'finished', paid: inv.balance === 0 }, { source: 'quickbooks', skipInvoice: true });
    db.prepare("UPDATE orders SET qb_invoice_id=?, qb_balance=?, created_at=?, qb_synced_at=datetime('now') WHERE id=?")
      .run(inv.id, inv.balance, `${inv.date} 00:00:00`, o.id);
    imported++;
  }
  return { imported, skipped };
}
