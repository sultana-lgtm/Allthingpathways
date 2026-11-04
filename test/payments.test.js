process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'x';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const { db, seed } = await import('../server/db.js');
const qb = await import('../server/integrations/quickbooks.js');
const O = await import('../server/orders.js');
const { verifyWebhook } = await import('../server/integrations/stripe.js');
seed(); qb.seedMock();

const mk = () => O.createOrder({ customer_name: 'Test Co', items: [{ description: 'Flyers', qty: 100, rate: 100 }] });

test('new order creates a QuickBooks invoice automatically', async () => {
  const o = await mk();
  assert.ok(o.qb_invoice_id);
  assert.equal(o.total, 10600);
  assert.equal((await qb.getInvoice(o.qb_invoice_id)).balance, 10600);
});

test('a card payment marks the order paid and the QuickBooks invoice paid', async () => {
  const o = await mk();
  const after = await O.recordCardPayment({ orderId: o.id, ref: 'pi_1', amount: o.total, last4: '4242' });
  assert.equal(after.paid, 1);
  assert.equal((await qb.getInvoice(o.qb_invoice_id)).balance, 0);
  assert.ok(db.prepare('SELECT qb_payment_id FROM payments WHERE ref=?').get('pi_1').qb_payment_id);
});

test('the same Stripe payment delivered twice is only counted once', async () => {
  const o = await mk();
  await O.recordCardPayment({ orderId: o.id, ref: 'pi_dup', amount: 5000, last4: '1111' });
  await O.recordCardPayment({ orderId: o.id, ref: 'pi_dup', amount: 5000, last4: '1111' });
  assert.equal(O.getOrder(o.id).payments.length, 1);
  assert.equal((await qb.getInvoice(o.qb_invoice_id)).balance, 5600);
  assert.equal(O.getOrder(o.id).paid, 0);
});

test('payment taken before the invoice exists is sent once the invoice is created', async () => {
  const o = await O.createOrder({ customer_name: 'Late Co', items: [{ description: 'Cards', qty: 1, rate: 1000 }] }, { skipInvoice: true });
  await O.recordPayment(o.id, { method: 'cash', amount: 500 });
  await O.syncInvoice(o.id);
  await O.syncPendingPayments();
  const row = db.prepare('SELECT qb_payment_id FROM payments WHERE order_id=?').get(o.id);
  assert.ok(row.qb_payment_id);
});

test('webhook signatures: valid accepted, tampered and stale rejected', () => {
  const body = JSON.stringify({ type: 'payment_intent.succeeded' }), t = Math.floor(Date.now() / 1000);
  const sig = (ts, b) => createHmac('sha256', 'whsec_t').update(`${ts}.${b}`).digest('hex');
  assert.equal(verifyWebhook(body, `t=${t},v1=${sig(t, body)}`, 'whsec_t').type, 'payment_intent.succeeded');
  assert.throws(() => verifyWebhook(body + ' ', `t=${t},v1=${sig(t, body)}`, 'whsec_t'));
  assert.throws(() => verifyWebhook(body, `t=${t - 4000},v1=${sig(t - 4000, body)}`, 'whsec_t'));
});
