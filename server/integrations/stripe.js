import { createHmac, timingSafeEqual } from 'node:crypto';
// Stripe Terminal (in-person card reader) — server-driven flow. BETA / part-finished:
// with STRIPE_SECRET_KEY + STRIPE_READER_ID it creates a card_present PaymentIntent and
// pushes it to the reader; otherwise a simulated reader is used so the flow can be demoed.
const key = process.env.STRIPE_SECRET_KEY;
const reader = process.env.STRIPE_READER_ID;
export const stripeMode = key && reader ? 'live' : 'demo'; // card reader
export const onlineMode = key ? 'live' : 'demo';       // hosted Checkout page (needs only the secret key)

async function stripe(path, params, method = 'POST') {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? new URLSearchParams(params) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe: ${j.error?.message || r.status}`);
  return j;
}

export async function startCardPayment(order, amount) {
  if (stripeMode === 'demo') return { id: `pi_demo_${order.number}_${Date.now()}`, demo: true };
  const pi = await stripe('payment_intents', { amount, currency: 'usd', 'payment_method_types[]': 'card_present',
    capture_method: 'automatic', 'metadata[order]': order.number, description: `Order ${order.number}` });
  await stripe(`terminal/readers/${reader}/process_payment_intent`, { payment_intent: pi.id });
  return { id: pi.id, demo: false };
}

export async function paymentStatus(id) {
  if (id.startsWith('pi_demo_')) return { status: 'requires_payment_method' };
  const pi = await stripe(`payment_intents/${id}?expand[]=latest_charge`, null, 'GET');
  return { status: pi.status, amount: pi.amount_received, last4: pi.latest_charge?.payment_method_details?.card_present?.last4 || pi.latest_charge?.payment_method_details?.card?.last4 };
}

/** Recent succeeded payment intents, for the card-payments matching screen. */
export async function recentCharges() {
  if (stripeMode === 'demo') return [];
  const j = await stripe('payment_intents?limit=50&expand[]=data.latest_charge', null, 'GET');
  return j.data.filter((p) => p.status === 'succeeded').map((p) => ({
    id: p.id, amount: p.amount_received, last4: p.latest_charge?.payment_method_details?.card_present?.last4 || '',
    created: new Date(p.created * 1000).toISOString(), order: p.metadata?.order || null }));
}

/** Settings-page check: confirms the key works and lists readers so the right STRIPE_READER_ID can be copied. */
export async function testConnection() {
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  const j = await stripe('terminal/readers?limit=20', null, 'GET');
  return { test_mode: key.startsWith('sk_test_') || key.startsWith('rk_test_'), configured_reader: reader || null,
    readers: j.data.map((r) => ({ id: r.id, label: r.label, status: r.status, type: r.device_type })) };
}

/** Verify a Stripe webhook signature (header format: t=...,v1=...). Returns the parsed event or throws. */
export function verifyWebhook(rawBody, header, secret) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) throw new Error('Stale or missing timestamp');
  const want = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const ok = String(header).split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3))
    .some((sig) => sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want)));
  if (!ok) throw new Error('Bad signature');
  return JSON.parse(rawBody);
}

/** Hosted Stripe Checkout page for the amount still owed. The customer pays on Stripe's own page. */
export async function createCheckout(order, amount, baseUrl) {
  if (!key) return { demo: true, id: `cs_demo_${order.number}_${Date.now()}` };
  const sess = await stripe('checkout/sessions', {
    mode: 'payment', client_reference_id: order.number, 'metadata[order]': order.number,
    'payment_intent_data[metadata][order]': order.number, 'payment_intent_data[description]': `Order ${order.number}`,
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': `Order ${order.number} - ${order.customer_name}`,
    ...(order.customer_email ? { customer_email: order.customer_email } : {}),
    success_url: `${baseUrl}/#/order/${order.id}?stripe=return`, cancel_url: `${baseUrl}/#/order/${order.id}` });
  return { id: sess.id, url: sess.url, demo: false };
}

export async function checkoutResult(sessionId) {
  const s = await stripe(`checkout/sessions/${sessionId}?expand[]=payment_intent.latest_charge`, null, 'GET');
  if (s.payment_status !== 'paid') return { paid: false };
  const pi = s.payment_intent;
  return { paid: true, ref: pi.id, amount: pi.amount_received, last4: pi.latest_charge?.payment_method_details?.card?.last4 || null };
}
