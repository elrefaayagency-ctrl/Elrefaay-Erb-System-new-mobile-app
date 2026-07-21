// utils/invoicePdf.js
// يولّد فاتورة PDF احترافية بتخطيط A4 عربي
// استخدمنا pdfkit مع الكتابة اليدوية للأرقام والنصوص
// ملاحظة: pdfkit لا يدعم Arabic shaping بشكل مدمج،
// لذا نستخدم unicode مباشرة مع خط مدمج والنصوص الإنجليزية للعناوين

const PDFDocument = require('pdfkit');
const path = require('path');

const GOLD   = '#B8860B';
const NAVY   = '#1B2A3D';
const DARK   = '#1A1A1A';
const GRAY   = '#666666';
const LGRAY  = '#F5F5F3';
const RED    = '#A83030';
const GREEN  = '#2E7D52';

// ──── تنسيق المبالغ ────
function fmtMoney(n) {
  return (Math.abs(n)||0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

// ──── Status labels ────
const STATUS_LABELS = {
  draft:'مسودة', confirmed:'مؤكدة', partial:'جزئي', paid:'مدفوعة',
  cancelled:'ملغاة', refunded:'مردودة'
};
const PAYMENT_LABELS = { cash:'نقدي', credit:'آجل', installment:'تقسيط' };

function generateInvoicePdf(invoiceData, stream) {
  const { invoice, items, payments, installments } = invoiceData;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top:40, bottom:40, left:50, right:50 },
    info: {
      Title: `Invoice ${invoice.invoice_number}`,
      Author: 'نجف وإضاءة ERP',
      Subject: `فاتورة مبيعات — ${invoice.invoice_number}`,
    }
  });

  doc.pipe(stream);

  const pageW  = doc.page.width;
  const pageH  = doc.page.height;
  const margin = 50;
  const inner  = pageW - margin*2;

  // ──── Helper: رسم خط أفقي ────
  const hLine = (y, color=LGRAY, w=inner) => doc.moveTo(margin,y).lineTo(margin+w,y).strokeColor(color).lineWidth(1).stroke();

  // ──── Helper: خلية جدول ────
  const cellText = (text, x, y, w, opts={}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
       .fontSize(opts.size||9)
       .fillColor(opts.color||DARK)
       .text(String(text||''), x, y, {
         width: w, align: opts.align||'left',
         lineBreak: false, ellipsis: true,
       });
  };

  // ═══ HEADER ═══
  // Gold bar
  doc.rect(0, 0, pageW, 8).fill(GOLD);

  // Logo area
  doc.rect(margin, 20, 120, 55).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(GOLD)
     .text('✦', margin+8, 28, { width:104, align:'center' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF')
     .text('NAJAF & LIGHTING', margin+5, 48, { width:110, align:'center' });

  // Company info (right side)
  doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY)
     .text(invoice.invoice_number || 'INV-00000', margin+130, 22, { width:inner-130, align:'right' });
  doc.font('Helvetica').fontSize(9).fillColor(GRAY)
     .text('INVOICE / فاتورة مبيعات', margin+130, 42, { width:inner-130, align:'right' });

  const statusColor = invoice.status==='paid' ? GREEN : invoice.status==='cancelled' ? RED : NAVY;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(statusColor)
     .text(STATUS_LABELS[invoice.status]||invoice.status, margin+130, 58, { width:inner-130, align:'right' });

  // ═══ INFO ROW ═══
  const infoY = 90;
  doc.rect(margin, infoY, inner, 1).fill(LGRAY);

  // Date box
  doc.rect(margin, infoY+4, 110, 32).fill(LGRAY);
  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
     .text('DATE / التاريخ', margin+5, infoY+7);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
     .text(invoice.invoice_date||'—', margin+5, infoY+18);

  // Due date box
  doc.rect(margin+115, infoY+4, 110, 32).fill(LGRAY);
  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
     .text('DUE DATE / الاستحقاق', margin+120, infoY+7);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
     .text(invoice.due_date||'عند الطلب', margin+120, infoY+18);

  // Payment type box
  doc.rect(margin+230, infoY+4, 110, 32).fill(LGRAY);
  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
     .text('PAYMENT / طريقة الدفع', margin+235, infoY+7);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
     .text(PAYMENT_LABELS[invoice.payment_type]||invoice.payment_type, margin+235, infoY+18);

  // Location box
  if (invoice.location_name) {
    doc.rect(margin+345, infoY+4, 110, 32).fill(LGRAY);
    doc.font('Helvetica').fontSize(7).fillColor(GRAY)
       .text('WAREHOUSE / المستودع', margin+350, infoY+7);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
       .text(invoice.location_name, margin+350, infoY+18);
  }

  // ═══ BILL TO / FROM ═══
  const billY = infoY + 44;
  hLine(billY, LGRAY);

  doc.font('Helvetica-Bold').fontSize(7).fillColor(GOLD)
     .text('BILL TO / الفاتورة إلى', margin, billY+6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
     .text(invoice.customer_name||'—', margin, billY+16);
  if (invoice.customer_code) {
    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
       .text('Code: '+invoice.customer_code, margin, billY+30);
  }
  if (invoice.customer_phone) {
    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
       .text('Tel: '+invoice.customer_phone, margin, billY+40);
  }
  if (invoice.customer_address) {
    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
       .text(invoice.customer_address, margin, billY+50, { width:250 });
  }

  // FROM (right)
  doc.font('Helvetica-Bold').fontSize(7).fillColor(GOLD)
     .text('FROM / من', margin+350, billY+6, { width:inner-350, align:'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
     .text('Najaf & Lighting', margin+350, billY+16, { width:inner-350, align:'right' });
  doc.font('Helvetica').fontSize(8).fillColor(GRAY)
     .text('Tel: +20 XXX XXX XXXX', margin+350, billY+30, { width:inner-350, align:'right' });
  doc.font('Helvetica').fontSize(8).fillColor(GRAY)
     .text('info@najaf-erp.com', margin+350, billY+40, { width:inner-350, align:'right' });

  // ═══ ITEMS TABLE ═══
  const tblY = billY + 72;

  // Header
  const cols = [
    { x:margin,     w:30,  label:'#',          align:'center' },
    { x:margin+30,  w:190, label:'DESCRIPTION / الصنف', align:'left' },
    { x:margin+220, w:50,  label:'SKU',         align:'center' },
    { x:margin+270, w:50,  label:'QTY / الكمية',align:'center' },
    { x:margin+320, w:65,  label:'UNIT PRICE',  align:'right' },
    { x:margin+385, w:40,  label:'DISC%',       align:'center' },
    { x:margin+425, w:70,  label:'TOTAL',       align:'right' },
  ];

  doc.rect(margin, tblY, inner, 18).fill(NAVY);
  cols.forEach(col => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF')
       .text(col.label, col.x+3, tblY+5, { width:col.w-6, align:col.align, lineBreak:false });
  });

  let rowY = tblY + 18;
  items.forEach((item, i) => {
    const isEven = i % 2 === 0;
    const rowH   = 20;
    if (isEven) doc.rect(margin, rowY, inner, rowH).fill(LGRAY);

    cellText(i+1,                      cols[0].x+3, rowY+6, cols[0].w-6, { align:'center', size:8 });
    cellText(item.product_name||'—',   cols[1].x+3, rowY+6, cols[1].w-6, { size:8 });
    cellText(item.sku||'—',            cols[2].x+3, rowY+6, cols[2].w-6, { align:'center', size:8, color:GRAY });
    cellText(item.quantity,            cols[3].x+3, rowY+6, cols[3].w-6, { align:'center', size:8 });
    cellText(fmtMoney(item.unit_price),cols[4].x+3, rowY+6, cols[4].w-6, { align:'right', size:8 });
    cellText((item.discount_pct||0)+'%',cols[5].x+3,rowY+6, cols[5].w-6, { align:'center', size:8, color:item.discount_pct>0?RED:GRAY });
    cellText(fmtMoney(item.line_total),cols[6].x+3, rowY+6, cols[6].w-6, { align:'right', size:9, bold:true });

    rowY += rowH;
  });

  hLine(rowY, GOLD);

  // ═══ TOTALS ═══
  const totY = rowY + 8;
  const totX = margin + 340;
  const totW = inner - 340;

  const totRows = [
    { label:'Subtotal / المجموع الفرعي', value: invoice.subtotal },
  ];
  if (invoice.discount_amount > 0) {
    totRows.push({ label:`Discount ${invoice.discount_pct||0}% / خصم`, value: -invoice.discount_amount, color: RED });
  }
  if (invoice.tax_amount > 0) {
    totRows.push({ label:`Tax ${invoice.tax_pct||0}% / ضريبة`, value: invoice.tax_amount });
  }
  totRows.push({ label:'TOTAL / الإجمالي', value: invoice.total, bold:true, size:11 });

  let ty = totY;
  totRows.forEach(row => {
    doc.font(row.bold?'Helvetica-Bold':'Helvetica').fontSize(row.size||8.5).fillColor(row.color||DARK)
       .text(row.label, totX, ty, { width:totW-80, align:'left' });
    doc.font(row.bold?'Helvetica-Bold':'Helvetica').fontSize(row.size||8.5).fillColor(row.bold?NAVY:(row.color||DARK))
       .text('EGP '+fmtMoney(row.value), totX, ty, { width:totW, align:'right' });
    ty += row.bold ? 16 : 13;
  });

  // Paid / Remaining
  doc.rect(totX, ty+2, totW, 0.5).fill(LGRAY);
  ty += 8;
  doc.font('Helvetica').fontSize(8).fillColor(GREEN)
     .text('Paid / المدفوع', totX, ty, { width:totW-80 });
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GREEN)
     .text('EGP '+fmtMoney(invoice.paid_amount||0), totX, ty, { width:totW, align:'right' });
  ty += 13;

  const balanceDue = (invoice.total||0) - (invoice.paid_amount||0);
  if (balanceDue > 0.01) {
    doc.rect(totX, ty, totW, 22).fill('#FFF3F3');
    doc.rect(totX, ty, 3, 22).fill(RED);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(RED)
       .text('BALANCE DUE / المتبقي', totX+8, ty+7, { width:totW-88 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(RED)
       .text('EGP '+fmtMoney(balanceDue), totX+8, ty+7, { width:totW-8, align:'right' });
    ty += 30;
  } else {
    doc.rect(totX, ty, totW, 22).fill('#F0FAF4');
    doc.rect(totX, ty, 3, 22).fill(GREEN);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GREEN)
       .text('PAID IN FULL / مدفوعة بالكامل ✓', totX+8, ty+7, { width:totW-8, align:'center' });
    ty += 30;
  }

  // ═══ INSTALLMENTS (if any) ═══
  if (installments && installments.length > 0) {
    const instY = Math.max(ty + 20, rowY + 10);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY)
       .text('INSTALLMENT SCHEDULE / جدول الأقساط', margin, instY);

    let iy = instY + 14;
    doc.rect(margin, iy, 300, 14).fill(NAVY);
    ['#','DUE DATE / الاستحقاق','AMOUNT','PAID','STATUS'].forEach((h, i) => {
      const xs = [margin, margin+20, margin+130, margin+210, margin+265];
      const ws = [20,110,80,55,35];
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFF')
         .text(h, xs[i]+2, iy+4, { width:ws[i]-4, align:i>1?'right':'left', lineBreak:false });
    });
    iy += 14;

    installments.forEach((inst, i) => {
      if (i%2===0) doc.rect(margin, iy, 300, 13).fill(LGRAY);
      const xs = [margin, margin+20, margin+130, margin+210, margin+265];
      const ws = [20,110,80,55,35];
      const sColor = inst.status==='paid'?GREEN:inst.status==='overdue'?RED:DARK;
      [i+1, inst.due_date, 'EGP '+fmtMoney(inst.amount),
       'EGP '+fmtMoney(inst.paid_amount),
       {pending:'منتظر',partial:'جزئي',paid:'مدفوع',overdue:'متأخر'}[inst.status]||inst.status
      ].forEach((val, ci) => {
        doc.font('Helvetica').fontSize(7).fillColor(ci===4?sColor:DARK)
           .text(String(val), xs[ci]+2, iy+4, { width:ws[ci]-4, align:ci>1?'right':'left', lineBreak:false });
      });
      iy += 13;
    });
  }

  // ═══ NOTES ═══
  const notesY = pageH - 100;
  if (invoice.notes) {
    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
       .text('Notes / ملاحظات: '+invoice.notes, margin, notesY, { width:inner/2 });
  }

  // ═══ FOOTER ═══
  hLine(pageH - 45, GOLD);
  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
     .text('Thank you for your business!  |  شكراً لتعاملكم معنا', margin, pageH-38, { width:inner, align:'center' });
  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
     .text(`Generated by نجف وإضاءة ERP  |  ${new Date().toLocaleDateString('en-GB')}`, margin, pageH-26, { width:inner, align:'center' });

  // Gold bottom bar
  doc.rect(0, pageH-8, pageW, 8).fill(GOLD);

  doc.end();
}

// ──── إيصال 80mm حراري ────
function generateThermalPdf(invoiceData, stream) {
  const { invoice, items } = invoiceData;
  const W = 226; // ~80mm in points

  const doc = new PDFDocument({ size:[W, 600], margins:{ top:10, bottom:10, left:8, right:8 } });
  doc.pipe(stream);

  const iw = W - 16;

  // Header
  doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK)
     .text('Najaf & Lighting', 8, 10, { width:iw, align:'center' });
  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
     .text('نجف وإضاءة', 8, 24, { width:iw, align:'center' });

  doc.moveTo(8,35).lineTo(W-8,35).strokeColor(DARK).dash(2,{space:2}).stroke().undash();

  doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK)
     .text(invoice.invoice_number, 8, 40, { width:iw, align:'center' });
  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
     .text(invoice.invoice_date||'', 8, 51, { width:iw, align:'center' });
  doc.font('Helvetica').fontSize(7).fillColor(DARK)
     .text('Customer: '+(invoice.customer_name||'—'), 8, 62, { width:iw });

  doc.moveTo(8,74).lineTo(W-8,74).strokeColor(DARK).stroke();

  // Items
  let y = 80;
  doc.font('Helvetica-Bold').fontSize(7)
     .text('Item', 8, y, { width:100 })
     .text('Qty', 108, y, { width:30, align:'center' })
     .text('Price', 138, y, { width:35, align:'right' })
     .text('Total', 173, y, { width:iw-165, align:'right' });
  y += 12;
  doc.moveTo(8,y).lineTo(W-8,y).strokeColor(LGRAY).stroke(); y += 4;

  items.forEach(item => {
    doc.font('Helvetica').fontSize(7).fillColor(DARK)
       .text((item.product_name||'').substring(0,18), 8, y, { width:100, lineBreak:false })
       .text(String(item.quantity), 108, y, { width:30, align:'center', lineBreak:false })
       .text(fmtMoney(item.unit_price), 138, y, { width:35, align:'right', lineBreak:false })
       .text(fmtMoney(item.line_total), 173, y, { width:iw-165, align:'right', lineBreak:false });
    y += 12;
  });

  doc.moveTo(8,y).lineTo(W-8,y).strokeColor(DARK).dash(2,{space:2}).stroke().undash(); y += 6;

  // Totals
  [
    ['Subtotal', invoice.subtotal],
    invoice.discount_amount > 0 ? ['Discount', -invoice.discount_amount] : null,
    invoice.tax_amount > 0 ? ['Tax', invoice.tax_amount] : null,
  ].filter(Boolean).forEach(([l,v]) => {
    doc.font('Helvetica').fontSize(7).text(l, 8, y, { width:iw/2 })
       .text('EGP '+fmtMoney(v), W/2, y, { width:iw/2, align:'right' });
    y += 11;
  });

  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY)
     .text('TOTAL', 8, y, { width:iw/2 })
     .text('EGP '+fmtMoney(invoice.total), W/2, y, { width:iw/2, align:'right' });
  y += 14;

  doc.font('Helvetica').fontSize(7).fillColor(invoice.paid_amount>=invoice.total?GREEN:RED)
     .text('Paid: EGP '+fmtMoney(invoice.paid_amount||0), 8, y)
     .text('Due: EGP '+fmtMoney(Math.max(0,(invoice.total||0)-(invoice.paid_amount||0))), W/2, y, { width:iw/2, align:'right' });
  y += 14;

  doc.moveTo(8,y).lineTo(W-8,y).strokeColor(DARK).stroke(); y += 8;
  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
     .text('Thank you! شكراً لتعاملكم', 8, y, { width:iw, align:'center' });

  // Resize page to content
  doc.page.height = y + 30;
  doc.end();
}

module.exports = { generateInvoicePdf, generateThermalPdf };
