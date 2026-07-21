// routes/customers.js
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const { all, get, run, insert } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction }               = require('../utils/auditLog');
const { getCustomerBalance }      = require('../utils/customerLedger');

router.use(authenticate);

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genCustomerCode() {
  return nextDocumentNumber('customer_code_seq', 'CUS', 4, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM customers`);
    return (r?.c || 0) + 1;
  });
}

// GET /api/customers
router.get('/', async (req, res) => {
  const { search, type, is_active, governorate, area } = req.query;
  let sql = `SELECT * FROM customers WHERE 1=1`;
  const params = [];
  if (search) {
    sql += ` AND (name LIKE ? OR code LIKE ? OR phone LIKE ?)`;
    const t = `%${search}%`; params.push(t,t,t);
  }
  if (type)        { sql += ` AND type=?`;        params.push(type); }
  if (governorate) { sql += ` AND governorate=?`; params.push(governorate); }
  if (area)        { sql += ` AND area=?`;        params.push(area); }
  if (is_active !== undefined)
    sql += ` AND is_active=${is_active==='true'||is_active==='1'?1:0}`;
  sql += ` ORDER BY name ASC`;

  const customerRows = await all(sql, params);
  const customers = await Promise.all(customerRows.map(async c => ({
    ...c, is_active: !!c.is_active,
    balance: await getCustomerBalance(c.id),
  })));
  res.json({ customers, count: customers.length });
});

// GET /api/customers/geo/list — قوائم المحافظات/المناطق المستخدمة فعلياً حالياً
// (تفيد في تعبئة فلاتر تقرير التحصيل بدون سرد كل القيم يدوياً)
// ملحوظة: لازم يتسجل *قبل* GET /:id عشان "geo" ماتتفسرش كـ :id
router.get('/geo/list', async (req, res) => {
  const governorates = await all(`SELECT DISTINCT governorate FROM customers WHERE governorate IS NOT NULL AND governorate != '' ORDER BY governorate`);
  const areas = await all(`SELECT DISTINCT area, governorate FROM customers WHERE area IS NOT NULL AND area != '' ORDER BY area`);
  res.json({
    governorates: governorates.map(r => r.governorate),
    areas: areas.map(r => ({ area: r.area, governorate: r.governorate })),
  });
});

// GET /api/customers/:id
router.get('/:id', async (req, res) => {
  const c = await get(`SELECT * FROM customers WHERE id=?`,[req.params.id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  const recentInvoices = await all(`
    SELECT id,invoice_number,invoice_date,total,paid_amount,status
    FROM invoices WHERE customer_id=?
    ORDER BY created_at DESC LIMIT 10
  `,[c.id]);

  res.json({
    customer: { ...c, is_active: !!c.is_active },
    balance: await getCustomerBalance(c.id),
    recent_invoices: recentInvoices,
  });
});

// GET /api/customers/:id/statement
router.get('/:id/statement', async (req, res) => {
  const c = await get(`SELECT * FROM customers WHERE id=?`,[req.params.id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  const invoices  = await all(`SELECT id,invoice_number,invoice_date,total,paid_amount,status FROM invoices WHERE customer_id=? ORDER BY invoice_date ASC`,[c.id]);
  const payments  = await all(`SELECT id,payment_number,payment_date,amount,payment_method FROM customer_payments WHERE customer_id=? ORDER BY payment_date ASC`,[c.id]);
  const installs  = await all(`SELECT * FROM customer_installments WHERE customer_id=? ORDER BY due_date ASC`,[c.id]);
  const returns_  = await all(`SELECT id,return_number,return_date,total_refund,status FROM sales_returns WHERE customer_id=? ORDER BY return_date DESC`,[c.id]);

  res.json({
    customer: c,
    balance: await getCustomerBalance(c.id),
    invoices, payments, installments: installs, returns: returns_,
  });
});

// POST /api/customers
router.post('/', authorize('admin','manager','sales'), async (req, res) => {
  const { name, name_en, type, phone, phone2, email, address, city, governorate, area, country,
          tax_number, contact_person, discount_pct, credit_limit,
          payment_terms, opening_balance, notes, code } = req.body;

  if (!name) return res.status(400).json({ error: 'اسم العميل مطلوب' });
  const custCode = code?.trim() || await genCustomerCode();
  if (await get(`SELECT id FROM customers WHERE code=?`,[custCode]))
    return res.status(409).json({ error: 'الكود مستخدم بالفعل' });

  const newId = await insert(`
    INSERT INTO customers
    (code,name,name_en,type,phone,phone2,email,address,city,governorate,area,country,
     tax_number,contact_person,discount_pct,credit_limit,payment_terms,opening_balance,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [custCode,name,name_en||null,type||'retail',phone||null,phone2||null,
     email||null,address||null,city||null,governorate||null,area||null,country||'مصر',
     tax_number||null,contact_person||null,
     parseFloat(discount_pct)||0, parseFloat(credit_limit)||0,
     parseInt(payment_terms)||0, parseFloat(opening_balance)||0, notes||null]
  );

  await logAction(req.user.id,'create','customer',newId,{ name, code: custCode });
  res.status(201).json({ customer: await get(`SELECT * FROM customers WHERE id=?`,[newId]) });
});

// PUT /api/customers/:id
router.put('/:id', authorize('admin','manager','sales'), async (req, res) => {
  const { id } = req.params;
  const c = await get(`SELECT * FROM customers WHERE id=?`,[id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  const f = req.body;
  await run(`UPDATE customers SET
    name=COALESCE(?,name), name_en=COALESCE(?,name_en), type=COALESCE(?,type),
    phone=COALESCE(?,phone), phone2=COALESCE(?,phone2), email=COALESCE(?,email),
    address=COALESCE(?,address), city=COALESCE(?,city),
    governorate=COALESCE(?,governorate), area=COALESCE(?,area),
    tax_number=COALESCE(?,tax_number), contact_person=COALESCE(?,contact_person),
    discount_pct=COALESCE(?,discount_pct), credit_limit=COALESCE(?,credit_limit),
    payment_terms=COALESCE(?,payment_terms), opening_balance=COALESCE(?,opening_balance),
    notes=COALESCE(?,notes),
    is_active=COALESCE(?,is_active), updated_at=datetime('now')
    WHERE id=?`,
    [f.name??null, f.name_en??null, f.type??null,
     f.phone??null, f.phone2??null, f.email??null,
     f.address??null, f.city??null,
     f.governorate??null, f.area??null,
     f.tax_number??null, f.contact_person??null,
     f.discount_pct!=null?parseFloat(f.discount_pct):null,
     f.credit_limit!=null?parseFloat(f.credit_limit):null,
     f.payment_terms!=null?parseInt(f.payment_terms):null,
     f.opening_balance!=null?parseFloat(f.opening_balance):null,
     f.notes??null,
     f.is_active!=null?(f.is_active?1:0):null, id]
  );

  await logAction(req.user.id,'update','customer',id,req.body);
  res.json({ customer: await get(`SELECT * FROM customers WHERE id=?`,[id]) });
});

// POST /api/customers/import
const tmpDir = path.join(__dirname,'../uploads/temp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir,{recursive:true});
const upload = multer({ dest: tmpDir, limits:{ fileSize:10*1024*1024 } });

router.post('/import', authorize('admin','manager'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'يرجى رفع ملف Excel' });
  try {
    const wb   = XLSX.readFile(req.file.path);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{ defval:'' });
    fs.unlink(req.file.path,()=>{});

    const results = { success:[], errors:[] };
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i+2;
      try {
        const name = String(row.name||row['اسم العميل']||'').trim();
        if (!name) { results.errors.push({ row:rowNum, error:'اسم العميل مطلوب' }); continue; }
        const code = String(row.code||row['الكود']||'').trim() || await genCustomerCode();
        if (await get(`SELECT id FROM customers WHERE code=?`,[code])) {
          results.errors.push({ row:rowNum, error:`الكود ${code} مستخدم` }); continue;
        }
        const newId = await insert(`
          INSERT INTO customers (code,name,type,phone,email,address,city,governorate,area,discount_pct,opening_balance,payment_terms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [code, name,
           String(row.type||row['النوع']||'retail').trim(),
           String(row.phone||row['الهاتف']||'').trim()||null,
           String(row.email||row['البريد']||'').trim()||null,
           String(row.address||row['العنوان']||'').trim()||null,
           String(row.city||row['المدينة']||'').trim()||null,
           String(row.governorate||row['المحافظة']||'').trim()||null,
           String(row.area||row['المنطقة']||'').trim()||null,
           parseFloat(row.discount_pct||row['نسبة الخصم']||0)||0,
           parseFloat(row.opening_balance||row['الرصيد الافتتاحي']||0)||0,
           parseInt(row.payment_terms||row['أيام السداد']||0)||0,
          ]);
        results.success.push({ row:rowNum, id:newId, code, name });
      } catch(e) { results.errors.push({ row:rowNum, error:e.message }); }
    }

    await logAction(req.user.id,'bulk_import','customer',null,{ imported:results.success.length });
    res.json({ message:`تم استيراد ${results.success.length} عميل`, imported:results.success.length, failed:results.errors.length, success_details:results.success, error_details:results.errors });
  } catch(e) {
    if (req.file) fs.unlink(req.file.path,()=>{});
    res.status(500).json({ error:'خطأ في قراءة الملف: '+e.message });
  }
});

// GET /api/customers/import/template
router.get('/import/template', async (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['name','code','type','phone','email','address','city','governorate','area','discount_pct','opening_balance','payment_terms'],
    ['محمد أحمد','','retail','01012345678','m@email.com','القاهرة — مدينة نصر','القاهرة','القاهرة','مدينة نصر',0,0,0],
    ['شركة النجوم','','wholesale','01099999999','','الجيزة','الجيزة','الجيزة','الدقي',10,5000,30],
  ]);
  XLSX.utils.book_append_sheet(wb,ws,'العملاء');
  const buf = XLSX.write(wb,{ type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename="customers_template.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── DELETE /api/customers/:id ──
// ── نفس المبدأ المطبّق على الموردين (راجع الشرح في suppliers.js): لا يوجد
//    hard delete لعميل مرتبط بفواتير حقيقية أبداً، فقط تعطيل (soft delete)
//    ومشروط برصيد صفري ومفيش فواتير لسه مفتوحة (غير مدفوعة بالكامل). ──
router.delete('/:id', authorize('admin'), async (req, res) => {
  const { id } = req.params;
  const c = await get(`SELECT * FROM customers WHERE id=?`,[id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });
  if (!c.is_active) return res.status(400).json({ error: 'العميل معطّل بالفعل' });

  const balance = await getCustomerBalance(id);
  if (balance && Math.abs(balance.balance) > 0.01)
    return res.status(400).json({
      error: `لا يمكن تعطيل العميل — يوجد رصيد قائم (${balance.balance.toFixed(2)} ج.م) — يجب تسوية الحساب أولاً`,
    });

  const openInvoices = await get(
    `SELECT COUNT(*) as c FROM invoices WHERE customer_id=? AND status IN ('confirmed','partial')`,[id]
  );
  if (openInvoices?.c > 0)
    return res.status(400).json({ error: 'لا يمكن تعطيل العميل — يوجد فواتير لسه غير مسددة بالكامل مرتبطة به' });

  await run(`UPDATE customers SET is_active=0, updated_at=datetime('now') WHERE id=?`,[id]);
  await logAction(req.user.id, 'deactivate', 'customer', id, null);
  res.json({ message: 'تم تعطيل العميل بنجاح' });
});

module.exports = router;
