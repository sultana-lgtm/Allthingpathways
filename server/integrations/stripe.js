// Stripe Terminal (in-person card reader) — server-driven flow. BETA / part-finished:
// with STRIPE_SECRET_KEY + STRIPE_READER_ID it creates a card_present PaymentIntent and
// pushes it to the reader; otherwise a simulated reader is used so the flow can be demoed.
const key = process.env.STRIPE_SECRET_KEY;
const reader = process.env.STRIPE_READER_ID;
export const stripeMode = key && reader ? 'live' : 'demo';

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
  return { status: pi.status, amount: pi.amount_received, last4: pi.latest_charge?.payment_method_details?.card_present?.last4 };
}

/** Recent succeeded payment intents, for the card-payments matching screen. */
export async function recentCharges() {
  if (stripeMode === 'demo') return [];
  const j = await stripe('payment_intents?limit=50&expand[]=data.latest_charge', null, 'GET');
  return j.data.filter((p) => p.status === 'succeeded').map((p) => ({
    id: p.id, amount: p.amount_received, last4: p.latest_charge?.payment_method_details?.card_present?.last4 || '',
    created: new Date(p.created * 1000).toISOString(), order: p.metadata?.order || null }));
}
