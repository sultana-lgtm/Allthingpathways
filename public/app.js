// PrintFlow Connect front end — vanilla JS, hash-routed single page app.
const $app = document.getElementById('app');
const STATUSES = [['received', 'Received'], ['production', 'In production'], ['finished', 'Finished'], ['delivered', 'Delivered']];
let me = null, prices = [];

// ---------- helpers ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const esc = (v) => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(esc).join('') : String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (s, ...v) => raw(s.reduce((a, str, i) => a + str + (i < v.length ? esc(v[i]) : ''), ''));
const money = (c) => '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const dollars = (c) => (c / 100).toFixed(2);
const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login' && path !== '/me') { me = null; render(); throw new Error('Please sign in'); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
let toastT;
function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 3200);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const $ = (sel, root = document) => root.querySelector(sel);
const on = (root, sel, ev, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, guard(fn)));
const go = (hash) => { location.hash = hash; };

// ---------- shell ----------
async function shell(active, content) {
  let counts = { order: 0, inquiry: 0, unclassified: 0 };
  try { counts = await api('/emails/counts'); } catch { /* ignore */ }
  const nav = [['orders', 'Orders'], ['new', 'New order'], ['review', 'Review queue', counts.order], ['inquiries', 'Inquiries', counts.inquiry],
    ['unclassified', 'Unclassified', counts.unclassified], ['reconcile', 'Reconcile'], ['cards', 'Card payments'], ['prices', 'Prices']];
  const m = me.modes;
  $app.innerHTML = html`<div class="layout"><nav class="side">
    <div class="brand">PrintFlow Connect<small>Orders · QuickBooks · Stripe</small></div>
    ${raw(nav.map(([k, label, n]) => html`<a href="#/${k}" class="${active === k ? 'on' : ''}"><span>${label}</span>${n ? raw(html`<span class="badge">${n}</span>`) : ''}</a>`.s).join(''))}
    <div class="foot"><div class="modes">QuickBooks: <b>${m.quickbooks}</b><br>Gmail: <b>${m.gmail}</b><br>Card reader: <b>${m.stripe}</b><br>AI summary: <b>${m.ai ? 'Claude' : 'basic'}</b></div>
      Signed in as ${me.username}<br><button id="logout" class="small">Sign out</button></div></nav>
    <main id="main"></main></div>`.s;
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; render(); };
  const main = $('#main');
  if (content) main.innerHTML = content.s;
  return main;
}

// ---------- line-item editor ----------
function itemsEditor(root, initial) {
  let items = initial.map((i) => ({ ...i }));
  if (!items.length) items.push({ description: '', qty: 1, rate: 0, price_id: null });
  const draw = () => {
    const sub = items.reduce((s, i) => s + Math.round((Number(i.qty) || 0) * i.rate), 0), tax = Math.round(sub * 0.06);
    root.innerHTML = html`<table class="items"><thead><tr><th style="width:26%">Price book</th><th>Description</th><th style="width:80px">Qty</th><th style="width:110px">Rate ($)</th><th class="num" style="width:100px">Amount</th><th></th></tr></thead><tbody>
      ${raw(items.map((it, n) => html`<tr data-n="${n}"><td><select data-f="price"><option value="">Custom…</option>${raw(prices.map((p) => html`<option value="${p.id}" ${p.id === it.price_id ? raw('selected') : ''}>${p.name}</option>`.s).join(''))}</select></td>
        <td><input data-f="description" value="${it.description}"></td><td><input data-f="qty" type="number" min="0" step="any" value="${it.qty}"></td>
        <td><input data-f="rate" type="number" min="0" step="0.01" value="${dollars(it.rate)}"></td>
        <td class="num">${money(Math.round((Number(it.qty) || 0) * it.rate))}</td><td><button type="button" class="small danger" data-f="del" aria-label="Remove line">✕</button></td></tr>`.s).join(''))}
      </tbody></table><div class="row" style="margin:8px 0"><button type="button" class="small" data-f="add">+ Add line</button></div>
      <div class="totals"><div><span>Subtotal</span><span>${money(sub)}</span></div><div><span>Tax (6%)</span><span>${money(tax)}</span></div><div class="t"><span>Total</span><span>${money(sub + tax)}</span></div></div>`.s;
    root.querySelectorAll('tr[data-n]').forEach((tr) => {
      const it = items[+tr.dataset.n];
      tr.querySelector('[data-f=price]').onchange = (e) => { const p = prices.find((x) => x.id === +e.target.value); if (p) Object.assign(it, { price_id: p.id, description: p.name, rate: p.rate }); else it.price_id = null; draw(); };
      tr.querySelector('[data-f=description]').oninput = (e) => (it.description = e.target.value);
      tr.querySelector('[data-f=qty]').onchange = (e) => { it.qty = Number(e.target.value); draw(); };
      tr.querySelector('[data-f=rate]').onchange = (e) => { it.rate = Math.round(Number(e.target.value) * 100) || 0; it.price_id = null; draw(); };
      tr.querySelector('[data-f=del]').onclick = () => { items.splice(+tr.dataset.n, 1); if (!items.length) items.push({ description: '', qty: 1, rate: 0, price_id: null }); draw(); };
    });
    root.querySelector('[data-f=add]').onclick = () => { items.push({ description: '', qty: 1, rate: 0, price_id: null }); draw(); };
  };
  draw();
  return { get: () => items.filter((i) => i.description.trim() && Number(i.qty) > 0) };
}

const orderCard = (o) => html`<a class="job" href="#/order/${o.id}"><div class="r"><b>${o.customer_name}</b><span>${money(o.total)}</span></div>
  <div class="r muted"><span>${o.number}</span><span class="${o.past_due ? 'past' : ''}">${o.due_date ? (o.past_due ? 'Past due ' : 'Due ') + fmtDate(o.due_date) : 'No due date'}</span></div>
  <div style="margin-top:6px"><span class="pill ${o.paid ? 'paid' : 'unpaid'}">${o.paid ? 'Paid' : 'Unpaid'}</span>
  ${o.qb_invoice_id ? raw('<span class="pill info">QB</span>') : raw('<span class="pill warn">No invoice</span>')}</div></a>`.s;

// ---------- views ----------
const tabState = { tab: 'open', q: '' };
async function viewOrders() {
  const main = await shell('orders', html`<div class="top"><h1>Orders</h1><span class="sp"></span>
    <button id="imp">Import from QuickBooks</button><button id="chk">Check email</button><a class="btn primary" href="#/new">+ New order</a></div>
    <div class="top"><div class="tabs" id="tabs"></div><span class="sp"></span><input class="search" id="q" type="search" placeholder="Search all orders…" value="${tabState.q}"></div>
    <div class="board" id="board"></div>`);
  const load = guard(async () => {
    const { orders, counts } = await api(`/orders?tab=${tabState.tab}&q=${encodeURIComponent(tabState.q)}`);
    $('#tabs', main).innerHTML = [['open', 'Open'], ['pastdue', 'Past due'], ['unpaid', 'Unpaid'], ['all', 'All']].map(([k, l]) =>
      html`<button data-t="${k}" class="${tabState.tab === k ? 'on' : ''}">${l}<span class="n">${counts[k]}</span></button>`.s).join('');
    on(main, '#tabs button', 'click', async (e) => { tabState.tab = e.currentTarget.dataset.t; load(); });
    $('#board', main).innerHTML = STATUSES.map(([k, l]) => {
      const col = orders.filter((o) => o.status === k);
      return html`<div class="col"><h3><span>${l}</span><span>${col.length}</span></h3>${raw(col.map(orderCard).join('') || '<div class="muted" style="padding:8px">Nothing here</div>')}</div>`.s;
    }).join('');
  });
  let t; $('#q', main).oninput = (e) => { tabState.q = e.target.value; clearTimeout(t); t = setTimeout(load, 200); };
  on(main, '#imp', 'click', async () => { const r = await api('/quickbooks/import', { method: 'POST' }); toast(`Imported ${r.imported} invoice(s), skipped ${r.skipped}`); load(); });
  on(main, '#chk', 'click', async () => { const r = await api('/email/check', { method: 'POST' }); toast(`New email: ${r.order} order, ${r.inquiry} inquiry, ${r.unclassified} unclassified`); shell('orders').then(() => viewOrders()); });
  load();
}

async function viewNew() {
  prices = await api('/prices');
  const main = await shell('new', html`<div class="top"><h1>New order</h1></div><form class="card" id="f">
    <div class="grid g3"><div><label>Customer *</label><input name="customer_name" required></div><div><label>Email</label><input name="customer_email" type="email"></div>
    <div><label>Phone</label><input name="customer_phone"></div><div><label>Due date</label><input name="due_date" type="date"></div></div>
    <div style="margin:12px 0"><label>Job details</label><textarea name="details" rows="3"></textarea></div>
    <h2>Line items</h2><div id="items"></div><div class="row" style="margin-top:14px"><button class="primary" id="save">Save order &amp; create QuickBooks invoice</button></div></form>`);
  const ed = itemsEditor($('#items', main), []);
  $('#f', main).onsubmit = guard(async (e) => {
    e.preventDefault();
    const btn = $('#save', main); btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(e.target)); body.items = ed.get();
      const o = await api('/orders', { method: 'POST', body });
      toast(o.qb_error ? `Order saved, but QuickBooks failed: ${o.qb_error}` : 'Order saved and invoiced', !!o.qb_error);
      go(`#/order/${o.id}`);
    } finally { btn.disabled = false; }
  });
}

async function viewOrder(id) {
  const o = await api('/orders/' + id);
  prices = await api('/prices');
  const paidAmt = o.payments.reduce((s, p) => s + p.amount, 0);
  const idx = STATUSES.findIndex(([k]) => k === o.status);
  const main = await shell('orders', html`<div class="top"><a href="#/orders">← Orders</a><h1>${o.number} · ${o.customer_name}</h1>
    <span class="pill ${o.paid ? 'paid' : 'unpaid'}">${o.paid ? 'Paid' : 'Unpaid'}</span>${o.past_due ? raw('<span class="pill unpaid">Past due</span>') : ''}</div>
    <div class="card"><div class="steps" id="steps">${raw(STATUSES.map(([k, l], n) => html`<button class="step ${n < idx ? 'done' : n === idx ? 'cur' : ''}" data-s="${k}">${l}</button>`.s).join(''))}</div>
      <div class="muted">Click a step to move the job.</div></div>
    <div class="card"><h2>Where this job stands</h2><div class="summary" id="sum">Writing summary…</div></div>
    <form class="card" id="f"><h2>Customer &amp; job</h2><div class="grid g3">
      <div><label>Customer</label><input name="customer_name" value="${o.customer_name}" required></div><div><label>Email</label><input name="customer_email" value="${o.customer_email}"></div>
      <div><label>Phone</label><input name="customer_phone" value="${o.customer_phone}"></div><div><label>Due date</label><input type="date" name="due_date" value="${o.due_date || ''}"></div></div>
      <div style="margin:12px 0"><label>Details</label><textarea name="details" rows="3">${o.details}</textarea></div>
      <h2>Items &amp; prices</h2><div id="items"></div><div class="row" style="margin-top:12px"><button class="primary">Save changes</button><span class="muted">Saving also updates the QuickBooks invoice.</span></div></form>
    <div class="grid g2"><div class="card"><h2>QuickBooks</h2><div id="qb"></div></div>
    <div class="card"><h2>Payments</h2><div id="pay"></div></div></div>
    <div class="card"><div class="top" style="margin:0 0 8px"><h2 style="margin:0">Invoice</h2><span class="sp"></span><a class="btn small" href="/api/orders/${o.id}/invoice.pdf" target="_blank">Open PDF</a></div>
      <iframe class="pdf" title="Invoice PDF" src="/api/orders/${o.id}/invoice.pdf"></iframe></div>`);
  api(`/orders/${id}/summary`).then((s) => ($('#sum', main).textContent = s.text)).catch(() => ($('#sum', main).textContent = 'Summary unavailable.'));
  const ed = itemsEditor($('#items', main), o.items);
  const reload = () => viewOrder(id);
  on(main, '.step', 'click', async (e) => { await api(`/orders/${id}/status`, { method: 'POST', body: { status: e.currentTarget.dataset.s } }); reload(); });
  $('#f', main).onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target)); body.items = ed.get();
    const r = await api(`/orders/${id}`, { method: 'PUT', body });
    toast(r.qb_error ? `Saved; QuickBooks update failed: ${r.qb_error}` : 'Saved', !!r.qb_error); reload();
  });
  $('#qb', main).innerHTML = html`${o.qb_error ? raw(html`<div class="err">${o.qb_error}</div>`.s) : ''}
    ${o.qb_invoice_id ? raw(html`<p>Invoice <b>#${o.qb_invoice_id}</b> · balance <b>${money(o.qb_balance ?? o.total)}</b><br><span class="muted">Last synced ${o.qb_synced_at || 'never'} (UTC). Paid status updates automatically every 15 minutes.</span></p>`.s)
      : raw('<p class="muted">No QuickBooks invoice yet.</p>')}
    <div class="row"><button id="sync">${o.qb_invoice_id ? 'Re-sync invoice' : 'Create invoice now'}</button>
    ${o.qb_invoice_id && me.modes.quickbooks === 'demo' && !o.paid ? raw('<button id="qbpay" class="small">Demo: mark paid in QuickBooks</button><button id="qbchk" class="small">Run paid-check now</button>') : ''}</div>`.s;
  on(main, '#sync', 'click', async () => { const r = await api(`/orders/${id}/sync`, { method: 'POST' }); toast(r.qb_error || 'QuickBooks synced', !!r.qb_error); reload(); });
  on(main, '#qbpay', 'click', async () => { await api(`/orders/${id}/qb-demo-pay`, { method: 'POST' }); toast('Invoice paid in QuickBooks (demo)'); reload(); });
  on(main, '#qbchk', 'click', async () => { const r = await api('/quickbooks/sync', { method: 'POST' }); toast(`Checked ${r.checked}, marked ${r.flipped} paid`); reload(); });

  $('#pay', main).innerHTML = html`<p>Paid <b>${money(paidAmt)}</b> of <b>${money(o.total)}</b></p>
    ${raw(o.payments.length ? html`<table>${raw(o.payments.map((p) => html`<tr><td>${p.created_at.slice(0, 10)}</td><td>${p.method}${p.last4 ? ' ••' + p.last4 : ''}</td><td class="num">${money(p.amount)}</td></tr>`.s).join(''))}</table>`.s : '<p class="muted">No payments recorded.</p>')}
    ${o.paid ? '' : raw(html`<div class="row" style="margin-top:10px"><select id="pm" style="width:90px"><option>cash</option><option>check</option><option>other</option></select>
      <input id="pa" type="number" step="0.01" style="width:110px" value="${dollars(o.total - paidAmt)}"><button id="addpay">Record payment</button></div>
      <div class="row" style="margin-top:10px"><button id="card">💳 Take card payment (reader)</button><span class="pill warn">beta</span></div><div id="cardmsg" class="muted" style="margin-top:6px"></div>`.s)}`.s;
  on(main, '#addpay', 'click', async () => { await api(`/orders/${id}/payments`, { method: 'POST', body: { method: $('#pm', main).value, amount: Math.round(Number($('#pa', main).value) * 100) } }); toast('Payment recorded'); reload(); });
  on(main, '#card', 'click', async () => {
    const t = await api(`/orders/${id}/terminal`, { method: 'POST' });
    const msg = $('#cardmsg', main);
    if (t.demo) {
      msg.innerHTML = html`Simulated reader waiting for ${money(t.amount)}… <button id="tap" class="small">Simulate card tap</button>`.s;
      $('#tap', main).onclick = guard(async () => { await api(`/orders/${id}/terminal-demo-complete`, { method: 'POST', body: { pi: t.id, amount: t.amount } }); toast('Card payment approved (demo)'); reload(); });
      return;
    }
    msg.textContent = `Present card on the reader for ${money(t.amount)}…`;
    for (let n = 0; n < 60; n++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await api(`/terminal/${t.id}?order=${id}`);
      if (s.status === 'succeeded') { toast('Card payment approved'); return reload(); }
      if (s.status === 'canceled') throw new Error('Card payment was canceled');
    }
    throw new Error('Timed out waiting for the reader');
  });
}

function emailCard(e, mode) {
  const d = e.draft || {};
  return html`<div class="card mail" data-id="${e.id}"><div class="row"><b>${e.subject || '(no subject)'}</b><span class="sp"></span><span class="muted">${e.from_name} &lt;${e.from_email}&gt; · ${e.received_at.slice(0, 10)}</span></div>
    <pre>${e.body}</pre>
    ${mode === 'review' ? raw(html`<form class="draft"><div class="grid g3"><div><label>Customer *</label><input name="customer_name" value="${d.customer_name}" required></div>
      <div><label>Email</label><input name="customer_email" value="${d.customer_email}"></div><div><label>Due date</label><input type="date" name="due_date" value="${d.due_date || ''}"></div></div>
      <div style="margin:8px 0"><label>Details</label><textarea name="details" rows="2">${d.details}</textarea></div><div class="items-host"></div>
      <div class="row" style="margin-top:10px"><button class="primary">Confirm → create order &amp; invoice</button><button type="button" class="danger dismiss">Dismiss</button></div></form>`.s) :
    mode === 'inquiry' ? raw(html`<div class="row"><a class="btn" href="mailto:${e.from_email}?subject=${encodeURIComponent('Re: ' + e.subject)}">Reply</a>
      <button class="to-order">Actually an order</button><button class="dismiss">Mark handled</button></div>`.s) :
    raw(html`<div class="row"><button class="to-order">It's an order</button><button class="to-inquiry">It's an inquiry</button><button class="danger dismiss">Dismiss</button></div>`.s)}</div>`.s;
}

async function viewEmails(kind, title, mode, blurb) {
  const [mails] = await Promise.all([api('/emails?kind=' + kind), api('/prices').then((p) => (prices = p))]);
  const main = await shell(mode === 'review' ? 'review' : kind === 'inquiry' ? 'inquiries' : 'unclassified', html`<div class="top"><h1>${title}</h1><span class="sp"></span><button id="chk">Check email</button></div>
    <p class="muted">${blurb}</p>${raw(mails.map((e) => emailCard(e, mode)).join('') || '<div class="card empty">Nothing waiting 🎉</div>')}`);
  on(main, '#chk', 'click', async () => { const r = await api('/email/check', { method: 'POST' }); toast(`New email: ${r.order} order, ${r.inquiry} inquiry, ${r.unclassified} unclassified`); route(); });
  main.querySelectorAll('.mail').forEach((card) => {
    const id = card.dataset.id, e = mails.find((m) => m.id == id);
    on(card, '.dismiss', 'click', async () => { await api(`/emails/${id}/dismiss`, { method: 'POST' }); toast('Dismissed'); route(); });
    on(card, '.to-order', 'click', async () => { await api(`/emails/${id}/reclassify`, { method: 'POST', body: { kind: 'order' } }); go('#/review'); });
    on(card, '.to-inquiry', 'click', async () => { await api(`/emails/${id}/reclassify`, { method: 'POST', body: { kind: 'inquiry' } }); route(); });
    const host = $('.items-host', card);
    if (host) {
      const ed = itemsEditor(host, (e.draft?.items) || []);
      $('.draft', card).onsubmit = guard(async (ev) => {
        ev.preventDefault();
        const body = Object.fromEntries(new FormData(ev.target)); body.items = ed.get();
        const o = await api(`/emails/${id}/confirm`, { method: 'POST', body });
        toast(o.qb_error ? `Order ${o.number} created; QuickBooks failed: ${o.qb_error}` : `Order ${o.number} created and invoiced`, !!o.qb_error);
        go(`#/order/${o.id}`);
      });
    }
  });
}

async function viewReconcile() {
  const r = await api('/reconcile');
  const main = await shell('reconcile', html`<div class="top"><h1>Reconcile</h1><span class="sp"></span><button id="sync">Run QuickBooks paid-check</button></div>
    <div class="card"><h2>Jobs with no QuickBooks invoice (${r.no_invoice.length})</h2>${raw(r.no_invoice.length ? html`<table><tr><th>Order</th><th>Customer</th><th class="num">Total</th><th>Problem</th><th></th></tr>
      ${raw(r.no_invoice.map((o) => html`<tr><td><a href="#/order/${o.id}">${o.number}</a></td><td>${o.customer_name}</td><td class="num">${money(o.total)}</td><td class="muted">${o.qb_error || 'Never invoiced'}</td><td><button class="small mk" data-id="${o.id}">Create invoice</button></td></tr>`.s).join(''))}</table>`.s : '<div class="empty">Every job has an invoice ✓</div>')}</div>
    <div class="card"><h2>Order emails with no matching job (${r.orphan_emails.length})</h2>${raw(r.orphan_emails.length ? html`<table><tr><th>From</th><th>Subject</th><th>Received</th><th>State</th></tr>
      ${raw(r.orphan_emails.map((e) => html`<tr><td>${e.from_name || e.from_email}</td><td>${e.subject}</td><td>${e.received_at.slice(0, 10)}</td><td>${e.state === 'pending' ? raw('<a href="#/review">Waiting in review queue</a>') : 'Dismissed'}</td></tr>`.s).join(''))}</table>`.s : '<div class="empty">Every order email became a job ✓</div>')}</div>`);
  on(main, '.mk', 'click', async (e) => { const o = await api(`/orders/${e.currentTarget.dataset.id}/sync`, { method: 'POST' }); toast(o.qb_error || 'Invoice created', !!o.qb_error); route(); });
  on(main, '#sync', 'click', async () => { const s = await api('/quickbooks/sync', { method: 'POST' }); toast(`Checked ${s.checked} invoices, ${s.flipped} newly paid`); });
}

async function viewCards() {
  const [pays, { orders }] = await Promise.all([api('/card-payments'), api('/orders?tab=all')]);
  const main = await shell('cards', html`<div class="top"><h1>Card payments</h1><span class="pill warn">beta</span><span class="sp"></span>
    ${me.modes.stripe === 'demo' ? raw('<button id="demo">Demo: add unmatched card payment</button>') : ''}</div>
    <p class="muted">Card-reader payments from Stripe. Anything not tied to a job shows here so you can match it.</p>
    <div class="card">${raw(pays.length ? html`<table><tr><th>Date</th><th>Card</th><th class="num">Amount</th><th>Order</th></tr>${raw(pays.map((p) => html`<tr><td>${p.created_at.slice(0, 16)}</td><td>${p.last4 ? '••' + p.last4 : '—'}</td><td class="num">${money(p.amount)}</td>
      <td>${raw(p.order_id ? html`<a href="#/order/${p.order_id}">${p.order_number}</a> · ${p.customer_name}`.s : html`<select class="m" data-id="${p.id}"><option value="">Unmatched — pick order…</option>${raw(orders.map((o) => html`<option value="${o.id}">${o.number} · ${o.customer_name} · ${money(o.total)}</option>`.s).join(''))}</select>`.s)}</td></tr>`.s).join(''))}</table>`.s : '<div class="empty">No card payments yet.</div>')}</div>`);
  on(main, '.m', 'change', async (e) => { if (!e.target.value) return; await api(`/card-payments/${e.target.dataset.id}/match`, { method: 'POST', body: { order_id: +e.target.value } }); toast('Matched'); route(); });
  on(main, '#demo', 'click', async () => { await api('/card-payments/demo', { method: 'POST', body: { amount: 5000 } }); route(); });
}

async function viewPrices() {
  prices = await api('/prices');
  const main = await shell('prices', html`<div class="top"><h1>Prices</h1></div><div class="card"><table><tr><th>Item</th><th>Category</th><th>Unit</th><th>Rate ($)</th><th>Made</th><th></th></tr>
    ${raw(prices.map((p) => priceRow(p)).join(''))}${raw(priceRow({ id: '', name: '', category: '', unit: 'each', rate: 0, source: 'in-house' }, true))}</table></div>`);
  main.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    const body = () => ({ name: $('[name=name]', tr).value, category: $('[name=category]', tr).value, unit: $('[name=unit]', tr).value, rate: Math.round(Number($('[name=rate]', tr).value) * 100), source: $('[name=source]', tr).value });
    on(tr, '.save', 'click', async () => { await api(id ? `/prices/${id}` : '/prices', { method: id ? 'PUT' : 'POST', body: body() }); toast('Saved'); route(); });
    on(tr, '.del', 'click', async () => { if (confirm('Delete this price?')) { await api(`/prices/${id}`, { method: 'DELETE' }); route(); } });
  });
}
const priceRow = (p, isNew) => html`<tr data-id="${p.id}"><td><input name="name" value="${p.name}" placeholder="${isNew ? 'New item…' : ''}"></td><td><input name="category" value="${p.category}"></td><td><input name="unit" value="${p.unit}"></td>
  <td><input name="rate" type="number" step="0.01" min="0" value="${dollars(p.rate)}"></td><td><select name="source"><option ${p.source === 'in-house' ? raw('selected') : ''}>in-house</option><option ${p.source === 'outsourced' ? raw('selected') : ''}>outsourced</option></select></td>
  <td class="row"><button class="small save">${isNew ? 'Add' : 'Save'}</button>${isNew ? '' : raw('<button class="small danger del">Delete</button>')}</td></tr>`.s;

// ---------- login & router ----------
function viewLogin() {
  $app.innerHTML = html`<form class="login" id="lf"><h1>PrintFlow Connect</h1><div class="muted">Staff sign in</div><div class="grid">
    <div><label>Username</label><input name="username" autocomplete="username" required autofocus></div><div><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
    <button class="primary">Sign in</button></div></form>`.s;
  $('#lf').onsubmit = guard(async (e) => {
    e.preventDefault();
    await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    me = await api('/me'); route();
  });
}

async function route() {
  const [, view = 'orders', arg] = location.hash.split('/');
  try {
    if (view === 'orders') return await viewOrders();
    if (view === 'new') return await viewNew();
    if (view === 'order') return await viewOrder(arg);
    if (view === 'review') return await viewEmails('order', 'Review queue', 'review', 'Orders parsed from email. Check the details, fix anything, then confirm.');
    if (view === 'inquiries') return await viewEmails('inquiry', 'Inquiries', 'inquiry', 'Questions and status checks — not new work.');
    if (view === 'unclassified') return await viewEmails('unclassified', 'Unclassified', 'unclassified', 'Threads the app could not tie to a job or customer.');
    if (view === 'reconcile') return await viewReconcile();
    if (view === 'cards') return await viewCards();
    if (view === 'prices') return await viewPrices();
    go('#/orders');
  } catch (e) { toast(e.message, true); }
}
async function render() {
  if (!me) { try { me = await api('/me'); } catch { return viewLogin(); } }
  route();
}
window.addEventListener('hashchange', () => me && route());
render();
