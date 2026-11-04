import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totals, invoicePdf } from '../server/util.js';

test('tax is 6% of line items, in cents', () => {
  assert.deepEqual(totals([{ qty: 500, rate: 45 }, { qty: 2, rate: 8500 }]), { subtotal: 39500, tax: 2370, total: 41870 });
});

test('invoice PDF is well formed', () => {
  const pdf = invoicePdf({ shop: { name: 'Shop' }, order: { number: 'PF-1', created_at: '2026-01-01 00:00:00', customer_name: 'A (B)', subtotal: 100, tax: 6, total: 106, paid: 0 }, items: [{ description: 'x', qty: 1, rate: 100 }] });
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.ok(pdf.toString().trimEnd().endsWith('%%EOF'));
});
