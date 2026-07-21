// routes/invoices.js
const express    = require('express');
const router     = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { getAllowedLocationIds }              = require('../utils/locationPermissions');
const eventBus = require('../utils/eventBus');
const { generateCommissionForInvoice }       = require('../utils/commissionEngine');

router.use(authenticate);

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// ملحوظة: كان هذا المولّد بيعتمد على COUNT(*) وده مش آمن تحت التزامن (راجع
// تعليق src/utils/sequenceGenerator.js لتفاصيل المشكلة) — تم استبداله بـ SEQUENCE ذرّي
async function genInvoiceNumber() {
  return nextDocumentNumber('invoice_number_seq', 'INV', 5, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM invoices`);
    return (r?.c || 0) + 1;
  });
}

const { getCustomerBalance, checkCreditLimit } = require('../utils/customerLedger');
const { validateInstallmentSchedule } = require('../utils/installmentEngine');
const { round2 } = require('../utils/money');

function calcInvoiceTotals(items, discPct, discAmt, taxPct) {
  let subtotal = 0;
  const enriched = items.map(item => {
    const gross     = item.quantity * item.unit_price;
    const lineDisc  = gross * (item.discount_pct||0) / 100;
    const lineTotal = round2(gross - lineDisc);
    subtotal += lineTotal;
    return { ...item, line_total: lineTotal };
  });
  subtotal = round2(subtotal);
  // ── إصلاح باج خصم مزدوج كان موجود هنا ──
  // كان بيستخدم `discAmt || (subtotal * discPct / 100)`: بما إن 0 قيمة
  // falsy في JavaScript، أي فاتورة يتبعتلها discount_amount=0 صراحةً (يعني
  // "من غير أي خصم إجمالي") كانت بتقع في القيمة البديلة وتحسب خصم بالنسبة
  // المئوية بدل ما تاخد الصفر المُرسَل فعلاً. دلوقتي بنفرّق بوضوح بين
  // "0 مُرسَل صراحةً" و"القيمة مش موجودة أصلاً" بمقارنة null/undefined.
  const discountAmount = round2(discAmt != null ? discAmt : (subtotal * (discPct||0) / 100));
  const afterDisc      = round2(subtotal - discountAmount);
  const taxAmount       = round2(afterDisc * (taxPct||0) / 100);
  const total           = round2(afterDisc + taxAmount);
  return { enriched, subtotal, discountAmount, taxAmount, total };
}

// ── تحقّق من صحة الأرقام المالية في الفاتورة قبل حسابها — خط دفاع مستقل عن الواجهة.
//    بيمنع أرقام غير منطقية (نسبة خصم سالبة أو أكبر من 100%، سعر سالب، خصم إجمالي
//    أكبر من قيمة الفاتورة نفسها...) من الوصول لقاعدة البيانات حتى لو حصل خطأ برمجي
//    أو تلاعب من طرف العميل (Client) بالطلب المرسل. ──
function validateInvoiceFinancials(items, discAmt, taxPct) {
  for (const item of items) {
    if (item.unit_price === undefined || item.unit_price < 0)
      return { error: 'سعر الوحدة يجب أن يكون رقماً موجباً' };
    if (item.discount_pct !== undefined && (item.discount_pct < 0 || item.discount_pct > 100))
      return { error: 'نسبة خصم البند يجب أن تكون بين 0 و 100%' };
  }
  if (discAmt !== undefined && discAmt !== null && discAmt < 0)
    return { error: 'الخصم الإجمالي لا يمكن أن يكون بالسالب' };
  if (taxPct !== undefined && taxPct !== null && (taxPct < 0 || taxPct > 100))
    return { error: 'نسبة الضريبة يجب أن تكون بين 0 و 100%' };
  const rawSubtotal = items.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
  if (discAmt && discAmt > rawSubtotal)
    return { error: 'الخصم الإجمالي أكبر من إجمالي الفاتورة قبل الخصم — تأكد من القيمة المدخلة' };
  return null;
}

// ── يتحقق من كل بند: منتج + كمية صحيحة + مخزن محدد + صلاحية المستخدم على المخزن
//    + توفر الكمية المطلوبة فعلياً في المخزن المختار. بيرجع رسالة خطأ واضحة أول
//    ما يلاقي مشكلة، عشان المستخدم يعرف بالظبط أنهي بند وأنهي مخزن السبب. ──
async function validateItemLocations(items, user) {
  const allowed = await getAllowedLocationIds(user);
  for (const item of items) {
    if (!item.product_id || !item.quantity || item.quantity <= 0)
      return { error: 'كل بند يجب أن يحتوي على منتج وكمية صحيحة' };
    if (!item.location_id)
      return { error: 'يجب تحديد المخزن لكل بند في الفاتورة' };
    if (allowed && !allowed.includes(Number(item.location_id))) {
      const p = await get(`SELECT name FROM products WHERE id=?`,[item.product_id]);
      return { error: `ليس لديك صلاحية على المخزن المختار للمنتج "${p?.name||''}"` };
    }
    const stock = await get(`SELECT quantity FROM inventory WHERE product_id=? AND location_id=?`,[item.product_id, item.location_id]);
    const qty   = stock?.quantity || 0;
    if (qty < item.quantity) {
      const p = await get(`SELECT name FROM products WHERE id=?`,[item.product_id]);
      const l = await get(`SELECT name FROM locations WHERE id=?`,[item.location_id]);
      return { error: `المخزون المتوفر من "${p?.name}" في "${l?.name||'المخزن المختار'}" هو ${qty} فقط` };
    }
  }
  return null;
}

// ── لو كل بنود الفاتورة من نفس المخزن، نخزّن المخزن ده على الفاتورة نفسها (للطباعة
//    والعرض السريع). لو البنود موزّعة على أكتر من مخزن، الفاتورة بتتسجل من غير
//    مخزن موحّد (location_id = null) والمرجع الحقيقي بيفضل على كل بند لوحده. ──
function resolveHeaderLocationId(items) {
  const ids = [...new Set(items.map(i => Number(i.location_id)))];
  return ids.length === 1 ? ids[0] : null;
}

// ── لو نوع الدفع "تقسيط"، بنتحقق إن جدول الأقساط منطقي فعلاً قبل ما نحفظه:
//    موجود، كل قسط فيه مبلغ فعلي (مش صفر)، ومجموع الأقساط قريب من إجمالي الفاتورة.
//    ده خط دفاع تاني (defense-in-depth) مستقل تمامًا عن الواجهة — حتى لو حصل باج
//    تاني في المتصفح يبعت أرقام غلط أو أصفار، السيرفر مش هيقبلها بصمت زي ما كان
//    بيحصل قبل كده (باج فعلي اتصلح: توليد الأقساط في الواجهة كان بيقرأ الإجمالي من
//    نص متنسّق محلياً بدل رقم خام، وعلى بعض المتصفحات ده كان بيرجّع صفر). ──
// ── لو نوع الدفع "تقسيط"، بنتحقق إن جدول الأقساط منطقي فعلاً قبل ما نحفظه —
//    منطق الفحص نفسه بقى موحّد في utils/installmentEngine.js (نفس الفحص
//    مطبّق الآن على أوامر الشراء للموردين كمان، بعد ما كان غير موجود هناك
//    خالص). هنا بس بوابة "هل الفحص مطلوب أصلاً؟" الخاصة بالفاتورة. ──
function validateInstallments(installments, total, paymentType) {
  if (paymentType !== 'installment') return null;
  return validateInstallmentSchedule(installments, total);
}

// ── تاريخ ووقت الفاتورة: تلقائي دايماً لأي مستخدم، والمدير (admin) فقط
//    هو اللي يقدر يحدد تاريخ/وقت مختلف يدوياً. أي مستخدم تاني بيبعت invoice_date
//    أو invoice_datetime في الطلب بيتجاهل تماماً من السيرفر — الحماية هنا في
//    الباكيند نفسه مش بس في الواجهة، عشان محدش يقدر يتلاعب بالتاريخ عبر الـ API مباشرة.
function resolveInvoiceDateTime(user, body) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  if (user.role === 'admin' && body.invoice_datetime) {
    const d = new Date(body.invoice_datetime);
    if (!isNaN(d.getTime())) {
      return { invoice_date: d.toISOString().split('T')[0], created_at: d.toISOString().slice(0,19).replace('T',' ') };
    }
  }
  if (user.role === 'admin' && body.invoice_date) {
    return { invoice_date: body.invoice_date, created_at: null };
  }
  return { invoice_date: today, created_at: null };
}

// ── GET /api/invoices ──
router.get('/', async (req, res) => {
  const { customer_id, status, payment_type, from_date, to_date, search } = req.query;
  let sql = `
    SELECT inv.*, c.name as customer_name, c.code as customer_code, c.type as customer_type,
           l.name as location_name, u.full_name as created_by
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    LEFT JOIN locations l ON inv.location_id = l.id
    LEFT JOIN users u ON inv.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (customer_id) { sql += ` AND inv.customer_id=?`;   params.push(customer_id); }
  if (status)      { sql += ` AND inv.status=?`;         params.push(status); }
  if (payment_type){ sql += ` AND inv.payment_type=?`;   params.push(payment_type); }
  if (from_date)   { sql += ` AND inv.invoice_date>=?`;  params.push(from_date); }
  if (to_date)     { sql += ` AND inv.invoice_date<=?`;  params.push(to_date); }
  if (search)      { sql += ` AND (inv.invoice_number LIKE ? OR c.name LIKE ?)`; const t=`%${search}%`; params.push(t,t); }
  sql += ` ORDER BY inv.created_at DESC LIMIT 500`;

  const invoices = (await all(sql, params)).map(inv => ({
    ...inv,
    balance_due: parseFloat((inv.total - inv.paid_amount).toFixed(2)),
  }));
  res.json({ invoices, count: invoices.length });
});

// ── GET /api/invoices/summary ── (لوحة التحكم)
router.get('/summary', async (req, res) => {
  const today  = new Date().toISOString().split('T')[0];
  const month  = today.substring(0,7);
  const stats  = await get(`
    SELECT
      COUNT(*) as total_count,
      COALESCE(SUM(CASE WHEN status NOT IN ('draft','cancelled') THEN total ELSE 0 END),0) as total_revenue,
      COALESCE(SUM(CASE WHEN status NOT IN ('draft','cancelled') THEN paid_amount ELSE 0 END),0) as total_collected,
      COALESCE(SUM(CASE WHEN invoice_date LIKE ? AND status NOT IN ('draft','cancelled') THEN total ELSE 0 END),0) as month_revenue,
      COUNT(CASE WHEN status='partial' OR (status='confirmed' AND paid_amount < total) THEN 1 END) as outstanding_count
    FROM invoices`, [month+'%']);

  res.json(stats);
});

// ── GET /api/invoices/:id ──
// ── دالة مشتركة لبناء تفاصيل الفاتورة الكاملة — يستخدمها كل من GET /:id
//    و GET /by-number/:number، عشان الشكل يفضل واحد متطابق دايماً مهما كان
//    طريقة البحث (بالـ id الداخلي أو برقم الفاتورة اللي يشوفه المستخدم) ──
async function buildInvoiceDetail(inv) {
  const items    = await all(`
    SELECT ii.*, p.name as product_name, p.sku, p.barcode, p.unit, l.name as location_name
    FROM invoice_items ii
    JOIN products p ON ii.product_id=p.id
    LEFT JOIN locations l ON ii.location_id=l.id
    WHERE ii.invoice_id=?`,[inv.id]);
  const payments = await all(`SELECT * FROM customer_payments WHERE invoice_id=? ORDER BY payment_date ASC`,[inv.id]);
  const installs = await all(`SELECT * FROM customer_installments WHERE invoice_id=? ORDER BY installment_number ASC`,[inv.id]);
  const returns_ = await all(`SELECT * FROM sales_returns WHERE invoice_id=?`,[inv.id]);
  return {
    invoice: { ...inv, balance_due: inv.total - inv.paid_amount },
    items, payments, installments: installs, returns: returns_,
  };
}

const INVOICE_DETAIL_JOIN = `
    SELECT inv.*, c.name as customer_name, c.code as customer_code,
           c.type as customer_type, c.phone as customer_phone,
           c.address as customer_address, c.tax_number as customer_tax,
           l.name as location_name, u.full_name as created_by
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    LEFT JOIN locations l ON inv.location_id = l.id
    LEFT JOIN users u ON inv.user_id = u.id
    WHERE `;

// ── GET /api/invoices/by-number/:number ──
// كانت مفقودة تماماً — دي كانت سبب "هذا المسار غير موجود" اللي بتظهر عند
// محاولة عمل مرتجع مبيعات والبحث عن الفاتورة برقمها من شاشة المردودات.
// لازم تتسجل *قبل* GET /:id، وإلا Express هيحاول يفسّر "by-number" كأنه
// قيمة :id نفسها ويحاول يدوّر برقم فاتورة اسمه "by-number".
router.get('/by-number/:number', async (req, res) => {
  const inv = await get(`${INVOICE_DETAIL_JOIN} inv.invoice_number = ?`, [req.params.number]);
  if (!inv) return res.status(404).json({ error: 'لا توجد فاتورة بهذا الرقم' });
  res.json(await buildInvoiceDetail(inv));
});

router.get('/:id', async (req, res) => {
  const inv = await get(`${INVOICE_DETAIL_JOIN} inv.id=?`, [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
  res.json(await buildInvoiceDetail(inv));
});

// ── POST /api/invoices ──
router.post('/', authorize('admin','manager','sales'), async (req, res) => {
  const { customer_id, location_id, invoice_date, due_date, payment_type,
          discount_pct, discount_amount, tax_pct, notes, notes_en,
          items, installments } = req.body;

  if (!customer_id)  return res.status(400).json({ error: 'العميل مطلوب' });
  if (!items?.length) return res.status(400).json({ error: 'يجب إضافة منتج واحد على الأقل' });

  const customer = await get(`SELECT * FROM customers WHERE id=? AND is_active=1`,[customer_id]);
  if (!customer) return res.status(404).json({ error: 'العميل غير موجود أو غير نشط' });

  // كل بند بيحدد مخزنه بنفسه (دعم البيع من أكتر من مخزن في نفس الفاتورة).
  // لو في بند قديم لسه باعت location_id على مستوى الفاتورة بس من غير ما يحددها لكل بند،
  // نطبّقها كقيمة افتراضية على البنود اللي ناقصاها، للتوافق مع نسخ قديمة من الواجهة.
  const itemsWithLocation = items.map(it => ({ ...it, location_id: it.location_id || location_id || null }));

  const stockError = await validateItemLocations(itemsWithLocation, req.user);
  if (stockError) return res.status(400).json(stockError);

  const financialError = validateInvoiceFinancials(itemsWithLocation, discount_amount, tax_pct);
  if (financialError) return res.status(400).json(financialError);

  // ── إصلاح باج الخصم المزدوج (الجذر الحقيقي) ──
  // كان بيرجع تلقائياً لخصم العميل الافتراضي (customer.discount_pct) كخصم
  // *على مستوى الفاتورة كلها* لما الفرونت إند ميبعتش discount_pct صراحةً —
  // بينما نفس خصم العميل الافتراضي أصلاً بيتطبّق على مستوى كل بند لوحده
  // (من الواجهة، ومرئي وقابل للتعديل هناك). النتيجة كانت خصم مزدوج صامت:
  // مرة على كل بند، ومرة تانية على الإجمالي بعد كده، من غير ما يظهر للمستخدم
  // في أي مكان في الفاتورة. الخصم على مستوى الفاتورة دلوقتي بيتطبّق بس لو
  // اتبعت صراحةً من العميل، زي discount_amount بالظبط.
  const effectiveDiscPct = discount_pct ?? 0;
  const { enriched, subtotal, discountAmount, taxAmount, total } =
    calcInvoiceTotals(itemsWithLocation, effectiveDiscPct, discount_amount, tax_pct);
  const headerLocationId = resolveHeaderLocationId(itemsWithLocation);

  const installError = validateInstallments(installments, total, payment_type);
  if (installError) return res.status(400).json(installError);

  const creditError = await checkCreditLimit(customer_id, total, payment_type||'cash');
  if (creditError && !(req.user.role === 'admin' && req.body.override_credit_limit)) {
    return res.status(400).json(creditError);
  }

  const { invoice_date: resolvedDate, created_at: overrideCreatedAt } = resolveInvoiceDateTime(req.user, req.body);

  const invoiceId = await transaction(async () => {
    const invoiceNumber = await genInvoiceNumber();
    const id = await insert(`
      INSERT INTO invoices
      (invoice_number,customer_id,location_id,invoice_date,due_date,status,payment_type,
       subtotal,discount_pct,discount_amount,tax_pct,tax_amount,total,paid_amount,notes,notes_en,user_id${overrideCreatedAt ? ',created_at,updated_at' : ''})
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?${overrideCreatedAt ? ',?,?' : ''})`,
      [invoiceNumber, customer_id, headerLocationId,
       resolvedDate,
       due_date||null, 'draft', payment_type||'cash',
       subtotal, effectiveDiscPct, discountAmount, tax_pct||0, taxAmount, total,
       notes||null, notes_en||null, req.user.id,
       ...(overrideCreatedAt ? [overrideCreatedAt, overrideCreatedAt] : [])]
    );

    // ── استخدام رصيد مرتجعات سابقة (store credit) كدفعة فورية على الفاتورة
    //    الجديدة، لو العميل طلب كده وعنده رصيد كافٍ ──
    const useStoreCredit = round2(parseFloat(req.body.use_store_credit) || 0);
    if (useStoreCredit > 0) {
      const cust = await get(`SELECT store_credit_balance FROM customers WHERE id=? FOR UPDATE`, [customer_id]);
      const available = round2(cust?.store_credit_balance || 0);
      if (useStoreCredit > available + 0.01) {
        const e = new Error(`رصيد المرتجعات المتاح للعميل ${available.toFixed(2)} ج.م فقط`);
        e.status = 400; throw e;
      }
      if (useStoreCredit > total + 0.01) {
        const e = new Error(`لا يمكن استخدام رصيد أكبر من إجمالي الفاتورة`);
        e.status = 400; throw e;
      }
      await run(`UPDATE customers SET store_credit_balance = store_credit_balance - ?, updated_at=datetime('now') WHERE id=?`,
        [useStoreCredit, customer_id]);
      const payNumber = await nextDocumentNumber('customer_payment_number_seq', 'RCP', 5, async () => {
        const r = await get(`SELECT COUNT(*) as c FROM customer_payments`);
        return (r?.c || 0) + 1;
      });
      await insert(`INSERT INTO customer_payments (payment_number,customer_id,invoice_id,amount,payment_method,payment_date,notes,user_id)
        VALUES (?,?,?,?,?,?,?,?)`,
        [payNumber, customer_id, id, useStoreCredit, 'store_credit', resolvedDate, 'استخدام رصيد مرتجعات سابقة', req.user.id]);
      await run(`UPDATE invoices SET paid_amount = paid_amount + ?, status = CASE WHEN paid_amount + ? >= total THEN 'paid' WHEN paid_amount + ? > 0 THEN 'partial' ELSE status END WHERE id=?`,
        [useStoreCredit, useStoreCredit, useStoreCredit, id]);
    }

    for (const item of enriched) {
      await insert(`INSERT INTO invoice_items (invoice_id,product_id,quantity,unit_price,discount_pct,line_total,location_id) VALUES (?,?,?,?,?,?,?)`,
        [id, item.product_id, item.quantity, item.unit_price, item.discount_pct||0, item.line_total, item.location_id]);
    }

    // جدول الأقساط إن وُجد
    if (Array.isArray(installments) && installments.length > 0) {
      for (let idx = 0; idx < installments.length; idx++) {
        const inst = installments[idx];
        await insert(`INSERT INTO customer_installments (invoice_id,customer_id,installment_number,amount,due_date,notes) VALUES (?,?,?,?,?,?)`,
          [id, customer_id, idx+1, inst.amount, inst.due_date, inst.notes||null]);
      }
    }

    return id;
  });

  await logAction(req.user.id,'create','invoice',invoiceId,{ customer_id, total, credit_limit_overridden: !!(creditError && req.body.override_credit_limit) });

  // إرسال إشعار الفاتورة الجديدة إلى تيليجرام (لا يوقف الرد لو فشل الإرسال)
  const invForMsg = await get(`
    SELECT inv.*, c.name as customer_name, l.name as location_name
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    LEFT JOIN locations l ON inv.location_id = l.id
    WHERE inv.id = ?`, [invoiceId]);
  const itemsForMsg = await all(`SELECT ii.*, p.name as product_name FROM invoice_items ii JOIN products p ON ii.product_id=p.id WHERE ii.invoice_id=?`, [invoiceId]);
  const installmentsForMsg = await all(`SELECT * FROM customer_installments WHERE invoice_id=? ORDER BY installment_number ASC`, [invoiceId]);
  eventBus.emit('invoice.created', { invoice: invForMsg, items: itemsForMsg, installments: installmentsForMsg, actorName: req.user.full_name });

  res.status(201).json({ message:'تم إنشاء الفاتورة بنجاح', invoice: await get(`SELECT * FROM invoices WHERE id=?`,[invoiceId]) });
});

// ── POST /api/invoices/:id/confirm ── (تأكيد الفاتورة = يخصم المخزون)
router.post('/:id/confirm', authorize('admin','manager','sales'), async (req, res) => {
  const inv = await get(`SELECT * FROM invoices WHERE id=?`,[req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'يمكن تأكيد المسودات فقط' });
  const items = await all(`SELECT * FROM invoice_items WHERE invoice_id=?`,[inv.id]);
  if (items.some(it => !it.location_id))
    return res.status(400).json({ error: 'يوجد بند في الفاتورة بدون مخزن محدد — يجب تعديل الفاتورة وتحديد مخزن لكل بند قبل التأكيد' });

  await transaction(async () => {
    // إصلاح race condition: قفل صف الفاتورة نفسه FOR UPDATE وإعادة التحقق
    // من حالتها *جوه* المعاملة. من غيرها، طلبين "تأكيد" متزامنين لنفس
    // الفاتورة (double-click أو retry) كانوا بيعدّوا فحص "draft" الأولي
    // (اللي بيحصل قبل المعاملة) بنجاح مع بعض، فيخصموا المخزون مرتين
    // ويولّدوا عمولة مكررة لنفس الفاتورة.
    const lockedInv = await get(`SELECT status FROM invoices WHERE id=? FOR UPDATE`,[inv.id]);
    if (!lockedInv || lockedInv.status !== 'draft') {
      const e = new Error('لا يمكن تأكيد هذه الفاتورة — تم تأكيدها بالفعل أو تغيّرت حالتها');
      e.status = 400; throw e;
    }

    for (const item of items) {
      // FOR UPDATE إلزامي هنا: من غيرها، طلبين بيأكدوا فاتورتين مختلفتين
      // لنفس المنتج/المخزن في نفس اللحظة تقريباً ممكن يقروا نفس الكمية
      // القديمة، والاتنين يعدّوا فحص "المخزون كافٍ"، والتاني يكتب فوق
      // تحديث الأول بدل ما يتجمعوا — نتيجتها بيع كمية أكتر من المتاح
      // فعلياً (Overselling) من غير ما السيرفر ياخد باله.
      const stock = await get(`SELECT * FROM inventory WHERE product_id=? AND location_id=? FOR UPDATE`,[item.product_id, item.location_id]);
      const before = stock?.quantity || 0;
      const after  = before - item.quantity;
      if (after < 0) {
        const p = await get(`SELECT name FROM products WHERE id=?`,[item.product_id]);
        const l = await get(`SELECT name FROM locations WHERE id=?`,[item.location_id]);
        throw new Error(`المخزون غير كافٍ للمنتج "${p?.name}" في "${l?.name||'المخزن'}" — المتوفر: ${before}`);
      }
      await run(`UPDATE inventory SET quantity=?, updated_at=datetime('now') WHERE product_id=? AND location_id=?`,
        [after, item.product_id, item.location_id]);
      await insert(`INSERT INTO stock_movements
        (product_id,location_id,movement_type,quantity,quantity_before,quantity_after,reference_type,reference_id,notes,user_id)
        VALUES (?,?,'out',?,?,?,'invoice',?,?,?)`,
        [item.product_id, item.location_id, -item.quantity, before, after, inv.id, `فاتورة مبيعات — ${inv.invoice_number}`, req.user.id]);
    }
    await run(`UPDATE invoices SET status=CASE WHEN payment_type='cash' THEN 'confirmed' ELSE 'confirmed' END, updated_at=datetime('now') WHERE id=?`,[inv.id]);
  });

  await logAction(req.user.id,'confirm','invoice',inv.id,null);

  // توليد سجل عمولة تلقائي لمندوب المبيعات صاحب الفاتورة (لو ينطبق عليه قاعدة عمولة مفعّلة)
  // ملحوظة: هذه العملية محاطة بـ try/catch داخلياً في commissionEngine ولن توقف تأكيد الفاتورة لو فشلت
  await generateCommissionForInvoice(inv.id);

  // إرسال إشعار تأكيد الفاتورة إلى تيليجرام
  const confirmedInv = await get(`
    SELECT inv.*, c.name as customer_name, l.name as location_name
    FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id
    LEFT JOIN locations l ON inv.location_id = l.id
    WHERE inv.id = ?`, [inv.id]);
  const confirmedItems = await all(`SELECT ii.*, p.name as product_name FROM invoice_items ii JOIN products p ON ii.product_id=p.id WHERE ii.invoice_id=?`, [inv.id]);
  const confirmedInstallments = await all(`SELECT * FROM customer_installments WHERE invoice_id=? ORDER BY installment_number ASC`, [inv.id]);
  eventBus.emit('invoice.confirmed', { invoice: confirmedInv, items: confirmedItems, installments: confirmedInstallments, actorName: req.user.full_name });

  res.json({ message:'تم تأكيد الفاتورة وتحديث المخزون', invoice: await get(`SELECT * FROM invoices WHERE id=?`,[inv.id]) });
});

// ── PUT /api/invoices/:id ── (تعديل فاتورة لسه مسودة فقط — بيستبدل البنود بالكامل)
router.put('/:id', authorize('admin','manager','sales'), async (req, res) => {
  const inv = await get(`SELECT * FROM invoices WHERE id=?`,[req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'لا يمكن تعديل فاتورة بعد تأكيدها — يمكن تعديل المسودات فقط' });

  const { customer_id, location_id, invoice_date, due_date, payment_type,
          discount_pct, discount_amount, tax_pct, notes, notes_en,
          items, installments } = req.body;

  if (!customer_id)  return res.status(400).json({ error: 'العميل مطلوب' });
  if (!items?.length) return res.status(400).json({ error: 'يجب إضافة منتج واحد على الأقل' });

  const customer = await get(`SELECT * FROM customers WHERE id=? AND is_active=1`,[customer_id]);
  if (!customer) return res.status(404).json({ error: 'العميل غير موجود أو غير نشط' });

  const itemsWithLocation = items.map(it => ({ ...it, location_id: it.location_id || location_id || null }));
  const stockError = await validateItemLocations(itemsWithLocation, req.user);
  if (stockError) return res.status(400).json(stockError);

  const financialError = validateInvoiceFinancials(itemsWithLocation, discount_amount, tax_pct);
  if (financialError) return res.status(400).json(financialError);

  // ── إصلاح باج الخصم المزدوج (الجذر الحقيقي) ──
  // كان بيرجع تلقائياً لخصم العميل الافتراضي (customer.discount_pct) كخصم
  // *على مستوى الفاتورة كلها* لما الفرونت إند ميبعتش discount_pct صراحةً —
  // بينما نفس خصم العميل الافتراضي أصلاً بيتطبّق على مستوى كل بند لوحده
  // (من الواجهة، ومرئي وقابل للتعديل هناك). النتيجة كانت خصم مزدوج صامت:
  // مرة على كل بند، ومرة تانية على الإجمالي بعد كده، من غير ما يظهر للمستخدم
  // في أي مكان في الفاتورة. الخصم على مستوى الفاتورة دلوقتي بيتطبّق بس لو
  // اتبعت صراحةً من العميل، زي discount_amount بالظبط.
  const effectiveDiscPct = discount_pct ?? 0;
  const { enriched, subtotal, discountAmount, taxAmount, total } =
    calcInvoiceTotals(itemsWithLocation, effectiveDiscPct, discount_amount, tax_pct);
  const headerLocationId = resolveHeaderLocationId(itemsWithLocation);

  const installError = validateInstallments(installments, total, payment_type);
  if (installError) return res.status(400).json(installError);

  const creditError = await checkCreditLimit(customer_id, total, payment_type||'cash');
  if (creditError && !(req.user.role === 'admin' && req.body.override_credit_limit)) {
    return res.status(400).json(creditError);
  }

  const { invoice_date: resolvedDate, created_at: overrideCreatedAt } = resolveInvoiceDateTime(req.user, req.body);

  await transaction(async () => {
    await run(`
      UPDATE invoices SET
        customer_id=?, location_id=?, invoice_date=?, due_date=?, payment_type=?,
        subtotal=?, discount_pct=?, discount_amount=?, tax_pct=?, tax_amount=?, total=?,
        notes=?, notes_en=?${overrideCreatedAt ? ', created_at=?' : ''}, updated_at=datetime('now')
      WHERE id=?`,
      [customer_id, headerLocationId, resolvedDate, due_date||null, payment_type||'cash',
       subtotal, effectiveDiscPct, discountAmount, tax_pct||0, taxAmount, total,
       notes||null, notes_en||null, ...(overrideCreatedAt ? [overrideCreatedAt] : []), inv.id]
    );

    // استبدال البنود بالكامل (الفاتورة لسه مسودة، لا يوجد مخزون اتخصم بعد، فالاستبدال آمن)
    await run(`DELETE FROM invoice_items WHERE invoice_id=?`,[inv.id]);
    for (const item of enriched) {
      await insert(`INSERT INTO invoice_items (invoice_id,product_id,quantity,unit_price,discount_pct,line_total,location_id) VALUES (?,?,?,?,?,?,?)`,
        [inv.id, item.product_id, item.quantity, item.unit_price, item.discount_pct||0, item.line_total, item.location_id]);
    }

    // استبدال جدول الأقساط بالكامل لو نوع الدفع تقسيط
    await run(`DELETE FROM customer_installments WHERE invoice_id=?`,[inv.id]);
    if (Array.isArray(installments) && installments.length > 0) {
      for (let idx = 0; idx < installments.length; idx++) {
        const inst = installments[idx];
        await insert(`INSERT INTO customer_installments (invoice_id,customer_id,installment_number,amount,due_date,notes) VALUES (?,?,?,?,?,?)`,
          [inv.id, customer_id, idx+1, inst.amount, inst.due_date, inst.notes||null]);
      }
    }
  });

  await logAction(req.user.id,'update','invoice',inv.id,{ customer_id, total, credit_limit_overridden: !!(creditError && req.body.override_credit_limit) });

  res.json({ message:'تم حفظ تعديلات الفاتورة', invoice: await get(`SELECT * FROM invoices WHERE id=?`,[inv.id]) });
});

// ── POST /api/invoices/:id/cancel ── (إلغاء فاتورة لسه مسودة — لا يوجد مخزون لرجوعه لأن المسودة لا تخصم المخزون)
router.post('/:id/cancel', authorize('admin','manager','sales'), async (req, res) => {
  const inv = await get(`SELECT * FROM invoices WHERE id=?`,[req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'لا يمكن إلغاء فاتورة بعد تأكيدها من هنا — استخدم المردودات بدلاً من ذلك' });

  await run(`UPDATE invoices SET status='cancelled', updated_at=datetime('now') WHERE id=?`,[inv.id]);
  await logAction(req.user.id,'cancel','invoice',inv.id,null);

  const cancelledInv = await get(`
    SELECT inv.*, c.name as customer_name FROM invoices inv
    JOIN customers c ON inv.customer_id = c.id WHERE inv.id=?`, [inv.id]);
  eventBus.emit('invoice.cancelled', { invoice: cancelledInv, actorName: req.user.full_name });

  res.json({ message:'تم إلغاء الفاتورة', invoice: cancelledInv });
});

// ── PUT /api/invoices/:id/status ──
router.put('/:id/status', authorize('admin','manager'), async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['draft','confirmed','partial','paid','cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });

  const inv = await get(`SELECT * FROM invoices WHERE id=?`,[req.params.id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

  await run(`UPDATE invoices SET status=?, updated_at=datetime('now') WHERE id=?`,[status, req.params.id]);
  res.json({ message:'تم تحديث الحالة' });
});

module.exports = router;