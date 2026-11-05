process.env.DB_FILE = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { seed } = await import('../server/db.js');
const { cleanBody, isJunk, summarizeEmail, classify, htmlToText } = await import('../server/integrations/parser.js');
seed();

test('cleanBody drops quoted replies, signatures and footers', () => {
  const raw = 'Yes please go ahead with 500 flyers.\n\nThanks,\nDana\n\nOn Mon, Oct 5, 2026 at 9:00 AM Shop <shop@x.com> wrote:\n> Here is the quote\n> total $225\n';
  assert.equal(cleanBody(raw), 'Yes please go ahead with 500 flyers.\n\nThanks,\nDana');
  assert.equal(cleanBody('Hello\n-- \nDana Realty\n555-1234'), 'Hello');
  assert.equal(cleanBody('Sent from my iPhone'), '');
});

test('junk filter catches newsletters and automatic mail but not customers', () => {
  assert.ok(isJunk({ from_email: 'news@brand.com', subject: 'Sale', body: 'x', headers: {} }));
  assert.ok(isJunk({ from_email: 'a@b.com', subject: 'Hi', body: 'x', headers: { 'list-unsubscribe': '<mailto:x>' } }));
  assert.ok(isJunk({ from_email: 'noreply@bank.com', subject: 'Statement', body: 'x', headers: {} }));
  assert.ok(isJunk({ from_email: 'a@b.com', subject: 'Automatic reply: away', body: 'x', headers: {} }));
  assert.ok(!isJunk({ from_email: 'dana@whitfield.com', subject: 'Order: flyers', body: 'Please print 500 flyers', headers: {} }));
});

test('order summary is one line with items and due date', () => {
  const body = 'Hi,\n\nPlease print:\n- 500 flyers 8.5x11\n- 2 yard signs\nneeded by 2026-11-14\n\nThanks';
  const c = classify({ from_email: 'd@x.com', subject: 'Order', body });
  assert.equal(c.kind, 'order');
  assert.equal(summarizeEmail('order', { ...c.draft, customer_name: 'Dana' }, body, 'Dana'), 'Dana: 500 × Flyers 8.5x11, 2 × Yard signs · due 2026-11-14');
});

test('inquiry summary drops the greeting and stays short', () => {
  const s = summarizeEmail('inquiry', null, 'Hi, can you tell me when our posters will be ready? Just checking in on the status. ' + 'More text. '.repeat(40), 'X');
  assert.ok(s.startsWith('can you tell me when our posters'));
  assert.ok(s.length <= 171);
});

test('html-only mail becomes readable text', () => {
  assert.equal(htmlToText('<p>Hello&nbsp;there</p><style>a{}</style><div>Two</div>').trim(), 'Hello there\nTwo');
});
