export const TAX_RATE = 0.06;

/** Money is stored as integer cents everywhere. */
export function totals(items) {
  const subtotal = items.reduce((s, i) => s + Math.round(Number(i.qty) * Number(i.rate)), 0);
  const tax = Math.round(subtotal * TAX_RATE);
  return { subtotal, tax, total: subtotal + tax };
}

export const money = (c) => `$${(c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
export const today = () => new Date().toISOString().slice(0, 10);

const esc = (s) => String(s ?? '').replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');

/** Minimal dependency-free PDF writer for the branded invoice (one page, Helvetica). */
export function invoicePdf({ shop, order, items }) {
  const ops = [];
  const text = (x, y, size, s, bold = false, rgb = '0.1 0.1 0.1') =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb} rg ${x} ${y} Td (${esc(s)}) Tj ET`);
  const rect = (x, y, w, h, rgb) => ops.push(`${rgb} rg ${x} ${y} ${w} ${h} re f`);
  const right = (xr, y, size, s, bold) => text(xr - esc(s).length * size * 0.52, y, size, s, bold);

  rect(0, 742, 612, 50, '0.09 0.30 0.55');
  text(40, 760, 22, shop.name, true, '1 1 1');
  text(400, 760, 16, 'INVOICE', true, '1 1 1');
  text(40, 715, 10, `Invoice: ${order.number}`, true);
  text(40, 701, 10, `Date: ${order.created_at.slice(0, 10)}`);
  text(40, 687, 10, `Due: ${order.due_date || '-'}`);
  text(330, 715, 10, 'Bill to', true);
  text(330, 701, 10, order.customer_name);
  if (order.customer_email) text(330, 687, 10, order.customer_email);
  if (order.customer_phone) text(330, 673, 10, order.customer_phone);

  let y = 640;
  rect(40, y - 6, 532, 20, '0.92 0.94 0.97');
  text(46, y, 10, 'Description', true); text(330, y, 10, 'Qty', true);
  right(480, y, 10, 'Rate', true); right(566, y, 10, 'Amount', true);
  y -= 24;
  for (const i of items.slice(0, 22)) {
    text(46, y, 10, String(i.description).slice(0, 52));
    text(330, y, 10, String(i.qty));
    right(480, y, 10, money(i.rate));
    right(566, y, 10, money(Math.round(i.qty * i.rate)));
    y -= 18;
  }
  y -= 10;
  right(480, y, 10, 'Subtotal'); right(566, y, 10, money(order.subtotal)); y -= 16;
  right(480, y, 10, 'Tax (6%)'); right(566, y, 10, money(order.tax)); y -= 20;
  right(480, y, 12, 'Total', true); right(566, y, 12, money(order.total), true); y -= 20;
  if (order.paid) text(46, y, 14, 'PAID IN FULL', true, '0.1 0.5 0.2');
  if (order.details) { text(40, 90, 9, 'Job details:', true); text(40, 77, 9, order.details.replace(/\s+/g, ' ').slice(0, 110)); }
  text(40, 50, 9, `Thank you for your business - ${shop.name}`, false, '0.4 0.4 0.4');

  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, n) => { offs.push(pdf.length); pdf += `${n + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
