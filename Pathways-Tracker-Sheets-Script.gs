// Paycheck Budget + Savings Tracker builder.
// In a blank Google Sheet: Extensions > Apps Script > paste this > Save > Run buildTracker.
const C = {cream:'#FAF7F2', sage:'#E3EBDC', matcha:'#A9BF9A', blush:'#F8E1E4', dblush:'#EBB7C0', text:'#4F5B4A', alt:'#F3F6EF', red:'#C0506A'};
const MONEY = '"$"#,##0.00';

function buildTracker() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(ss.getSpreadsheetTimeZone());
  let b = ss.getSheetByName('Paycheck Budget') || ss.getActiveSheet().setName('Paycheck Budget');
  let s = ss.getSheetByName('Savings Tracker') || ss.insertSheet('Savings Tracker');
  budget_(b); savings_(s);
  ss.setActiveSheet(b);
}

function base_(sh, widths, rows) {
  sh.clear(); sh.setHiddenGridlines(true);
  sh.getRange(1, 1, rows, 8).setBackground(C.cream).setFontFamily('Georgia').setFontColor(C.text).setVerticalAlignment('middle');
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setRowHeights(1, rows, 26); sh.setRowHeight(2, 44);
}
function box_(r, fill, bold) {
  r.setBackground(fill).setBorder(true, true, true, true, true, true, '#D9E0D3', SpreadsheetApp.BorderStyle.SOLID);
  if (bold) r.setFontWeight('bold');
}
function title_(sh, range, text, size) {
  sh.getRange(range).merge().setValue(text).setFontSize(size).setFontWeight('bold').setHorizontalAlignment('center');
}
function input_(r) { r.setBackground('#FFFFFF').setBorder(true, true, true, true, false, false, C.dblush, SpreadsheetApp.BorderStyle.SOLID_MEDIUM).setFontColor('#7A4A54'); }

function budget_(sh) {
  base_(sh, [30, 210, 120, 120, 120, 110, 30, 30], 26);
  title_(sh, 'B2:F2', '✿ Paycheck Budget Tracker', 22);
  sh.getRange('B3:F3').merge().setValue('break down each paycheck · type in the white boxes').setFontStyle('italic').setFontSize(10).setHorizontalAlignment('center');
  box_(sh.getRange('B5:B6'), C.sage, true);
  sh.getRange('B5:B6').setValues([['Paycheck date'], ['Paycheck amount (after tax)']]);
  sh.getRange('C5').setNumberFormat('mmm d, yyyy'); sh.getRange('C6').setValue(0).setNumberFormat(MONEY);
  input_(sh.getRange('C5:C6')); sh.getRange('C5:C6').setHorizontalAlignment('center');
  sh.getRange('D5:F5').setValues([['Total planned', 'Total spent', 'Left to assign']]);
  sh.getRange('D6:F6').setFormulas([['=SUM(C11:C21)', '=SUM(D11:D21)', '=C6-D6']]).setNumberFormat(MONEY);
  box_(sh.getRange('D5:E6'), C.sage, true); box_(sh.getRange('F5:F6'), C.blush, true);
  sh.getRange('D5:F6').setHorizontalAlignment('center');
  sh.getRange('B8').setValue('Categories').setFontSize(14).setFontWeight('bold');
  sh.getRange('B10:F10').setValues([['Category', 'Planned', 'Actual spent', 'Remaining', '% of paycheck']])
    .setBackground(C.matcha).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  const cats = ['Rent / Bills','Groceries','Transportation','Dining & Coffee','Self-care','Shopping','Subscriptions','Fun & Outings','Debt Payments','Savings','Other'];
  const rows = cats.map((c, i) => { const r = 11 + i; return [c, 0, 0, `=C${r}-D${r}`, `=IF($C$6=0,0,C${r}/$C$6)`]; });
  const body = sh.getRange(11, 2, cats.length, 5);
  body.setValues(rows); body.setBorder(true, true, true, true, true, true, '#D9E0D3', SpreadsheetApp.BorderStyle.SOLID);
  body.setBackgrounds(cats.map((_, i) => Array(5).fill(i % 2 ? C.alt : '#FFFFFF')));
  sh.getRange('C11:E21').setNumberFormat(MONEY); sh.getRange('F11:F21').setNumberFormat('0%').setHorizontalAlignment('center');
  sh.getRange('C11:D21').setFontColor('#7A4A54');
  sh.getRange('B22:F22').setValues([['TOTAL', '=SUM(C11:C21)', '=SUM(D11:D21)', '=SUM(E11:E21)', '=IF($C$6=0,0,C22/$C$6)']]);
  box_(sh.getRange('B22:F22'), C.blush, true);
  sh.getRange('C22:E22').setNumberFormat(MONEY); sh.getRange('F22').setNumberFormat('0%').setHorizontalAlignment('center');
  sh.getRange('B24:F24').merge().setValue('tip: rename any category in column B · duplicate this tab for each paycheck').setFontStyle('italic').setFontSize(10).setHorizontalAlignment('center');
  const red = SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor(C.red).setBold(true).setBackground(C.blush);
  sh.setConditionalFormatRules([
    red.setRanges([sh.getRange('E11:E21'), sh.getRange('F6')]).build(),
    SpreadsheetApp.newConditionalFormatRule().setGradientMinpointWithValue('#FFFFFF', SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setGradientMaxpointWithValue(C.matcha, SpreadsheetApp.InterpolationType.NUMBER, '0.5').setRanges([sh.getRange('F11:F21')]).build()]);
}

function savings_(sh) {
  base_(sh, [30, 150, 230, 140, 140, 30, 30, 30], 45);
  title_(sh, 'B2:E2', '❀ Savings Tracker', 22);
  sh.getRange('B3:E3').merge().setValue('little deposits, big dreams').setFontStyle('italic').setFontSize(10).setHorizontalAlignment('center');
  sh.getRange('B5:B6').setValues([['Savings goal'], ['Goal amount']]); box_(sh.getRange('B5:B6'), C.sage, true);
  sh.getRange('C5').setValue('My dream fund'); sh.getRange('C6').setValue(1000).setNumberFormat(MONEY);
  input_(sh.getRange('C5:C6')); sh.getRange('C5:C6').setHorizontalAlignment('center');
  sh.getRange('D5:E5').setValues([['Total saved', 'Remaining']]);
  sh.getRange('D6:E6').setFormulas([['=SUM(D13:D112)', '=MAX(C6-D6,0)']]).setNumberFormat(MONEY);
  box_(sh.getRange('D5:D6'), C.sage, true); box_(sh.getRange('E5:E6'), C.blush, true);
  sh.getRange('D5:E6').setHorizontalAlignment('center');
  sh.getRange('B8:E8').merge().setFormula('=REPT("♥",ROUND(IF(C6=0,0,MIN(D6/C6,1))*20))&REPT("♡",20-ROUND(IF(C6=0,0,MIN(D6/C6,1))*20))')
    .setFontSize(16).setFontColor(C.dblush).setHorizontalAlignment('center');
  sh.getRange('B9:E9').merge().setFormula('=TEXT(IF(C6=0,0,D6/C6),"0%")&" of your goal"').setFontWeight('bold').setFontSize(12).setHorizontalAlignment('center');
  sh.getRange('B11').setValue('Deposit log').setFontSize(14).setFontWeight('bold');
  sh.getRange('B12:D12').setValues([['Date', 'Note', 'Amount']]).setBackground(C.matcha).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  const log = sh.getRange('B13:D112');
  log.setBorder(true, true, true, true, true, true, '#D9E0D3', SpreadsheetApp.BorderStyle.SOLID).setBackground('#FFFFFF');
  sh.getRange('B13:B112').setNumberFormat('mmm d, yyyy').setHorizontalAlignment('center');
  sh.getRange('D13:D112').setNumberFormat(MONEY);
  sh.setFrozenRows(12);
}
