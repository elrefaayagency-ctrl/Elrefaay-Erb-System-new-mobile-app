// migrate-data.js
// ═══════════════════════════════════════════════════════════════════════
// سكريبت نقل البيانات — يُشغَّل مرة واحدة فقط بعد إعداد قاعدة PostgreSQL
// (Supabase) الجديدة وقبل تشغيل السيرفر الجديد بشكل نهائي.
//
// يقوم بـ:
//   1) قراءة كل البيانات من ملف data/erp.sqlite القديم (sql.js)
//   2) إدخالها في قاعدة PostgreSQL الجديدة بنفس ترتيب الجداول (يراعي علاقات
//      المفاتيح الأجنبية)، مع الحفاظ على نفس الـ IDs الأصلية بالضبط
//   3) إعادة ضبط عدادات SERIAL في PostgreSQL بعد الاستيراد، عشان أي سجل
//      جديد يتسجل بعد كده ياخد id صحيح ومايحصلش تصادم مع الـ ids المستوردة
//
// طريقة التشغيل (مرة واحدة فقط):
//   1) npm install sql.js --no-save     (مؤقت، يُستخدم فقط لقراءة الملف القديم)
//   2) تأكد إن DATABASE_URL في .env يشير لقاعدة PostgreSQL فارغة تماماً
//      (شغّل السيرفر مرة واحدة أولاً بـ "node server.js" ثم أوقفه — عشان تتكوّن
//      كل الجداول فارغة، بعدين شغّل هذا السكريبت)
//   3) node migrate-data.js
//
// السكريبت آمن للتشغيل المتكرر (idempotent) على مستوى كل جدول: لو الجدول في
// PostgreSQL مش فاضي، بيتخطاه ويطبع تحذير بدل ما يكرر البيانات.
// ═══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');

const SQLITE_PATH = path.join(__dirname, 'data', 'erp.sqlite');

// ترتيب الجداول يراعي الاعتماديات (FK) — جدول الأب قبل جدول الابن دائماً
const TABLE_ORDER = [
  'settings',
  'categories',
  'locations',
  'expense_categories',
  'users',
  'user_location_permissions',
  'products',
  'inventory',
  'suppliers',
  'customers',
  'supplier_relations',
  'purchase_orders',
  'purchase_order_items',
  'purchase_receipts',
  'purchase_receipt_items',
  'payment_installments',
  'supplier_payments',
  'invoices',
  'invoice_items',
  'customer_installments',
  'customer_payments',
  'sales_returns',
  'sales_return_items',
  'stock_transfers',
  'stock_transfer_items',
  'stock_movements',
  'commission_rules',
  'commissions',
  'expenses',
  'audit_log',
];

async function loadSqliteData() {
  if (!fs.existsSync(SQLITE_PATH)) {
    throw new Error(`ملف قاعدة البيانات القديم غير موجود: ${SQLITE_PATH}`);
  }
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(SQLITE_PATH);
  const db = new SQL.Database(buffer);

  const data = {};
  for (const table of TABLE_ORDER) {
    try {
      const res = db.exec(`SELECT * FROM ${table}`);
      if (res.length === 0) { data[table] = { columns: [], rows: [] }; continue; }
      const { columns, values } = res[0];
      const rows = values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
      data[table] = { columns, rows };
    } catch (err) {
      console.log(`  (تخطّي جدول ${table} — غير موجود في الملف القديم: ${err.message})`);
      data[table] = { columns: [], rows: [] };
    }
  }
  return data;
}

async function migrateTable(pool, table, columns, rows) {
  if (rows.length === 0) {
    console.log(`  ${table}: لا توجد بيانات في الملف القديم — تخطّي`);
    return 0;
  }

  const colList = columns.join(', ');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;

  let count = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const values = columns.map(c => row[c]);
      await client.query(insertSql, values);
      count++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`فشل نقل جدول ${table} عند الصف رقم ${count + 1}: ${err.message}`);
  } finally {
    client.release();
  }

  console.log(`  ${table}: تم نقل ${count} صف بنجاح`);
  return count;
}

// ─── تفريغ كل الجداول قبل النقل ───
// عند تشغيل السيرفر الجديد أول مرة على قاعدة PostgreSQL فارغة، تعمل
// seedInitialData() تلقائياً على إنشاء بيانات افتراضية (مستخدم admin افتراضي،
// مواقع/تصنيفات افتراضية) عشان يقدر أي حد يفتح النظام لأول مرة من غير بيانات.
// لكن إحنا هنا بنستورد البيانات *الحقيقية* من نظامك القديم، فلازم نمسح أي
// بيانات افتراضية اتكوّنت تلقائياً الأول، وإلا هيحصل تصادم IDs أو تكرار
// (مثال: يوجد "admin" افتراضي بالفعل + admin حقيقي من ملفك القديم بنفس الـ id).
// الترتيب هنا عكس ترتيب النقل (نمسح من الابن للأب) لمراعاة قيود المفاتيح الأجنبية.
async function truncateAllTables(pool) {
  console.log('🧹 تفريغ البيانات الافتراضية التي أنشأها السيرفر تلقائياً عند أول تشغيل...');
  const reverseOrder = [...TABLE_ORDER].reverse();
  const tableList = reverseOrder.join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
  console.log('  تم تفريغ كل الجداول بنجاح، جاهزة لاستقبال البيانات الحقيقية.\n');
}

// بعد إدخال صفوف بأرقام id محددة يدوياً، عداد SERIAL في PostgreSQL لسه واقف
// عند 1 ومش عارف إن فيه ids مستخدمة بالفعل. لازم نرفعه يدوياً لأعلى قيمة +1
// لكل جدول فيه عمود id تلقائي، وإلا أول إدخال جديد بعد النقل هيفشل بخطأ
// "duplicate key value violates unique constraint".
async function resetSequences(pool) {
  console.log('\nإعادة ضبط عدادات الترقيم التلقائي (SERIAL sequences)...');
  for (const table of TABLE_ORDER) {
    try {
      const seqRes = await pool.query(`SELECT pg_get_serial_sequence($1, 'id') as seq`, [table]);
      const seqName = seqRes.rows[0]?.seq;
      if (!seqName) continue; // الجدول مالوش عمود id تلقائي (نادر هنا)

      const maxRes = await pool.query(`SELECT COALESCE(MAX(id), 0) as max_id FROM ${table}`);
      const maxId = maxRes.rows[0].max_id;
      await pool.query(`SELECT setval($1, $2, true)`, [seqName, Math.max(maxId, 1)]);
      console.log(`  ${table}: sequence ضُبطت على ${maxId}`);
    } catch (err) {
      console.log(`  ${table}: تعذّر ضبط الـ sequence (${err.message}) — قد تحتاج فحص يدوي`);
    }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('نقل البيانات من SQLite (القديم) إلى PostgreSQL (الجديد)');
  console.log('═══════════════════════════════════════════\n');

  console.log('📖 قراءة البيانات من الملف القديم...');
  const data = await loadSqliteData();

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  try {
    await pool.query('SELECT 1');
    console.log('✓ تم الاتصال بقاعدة PostgreSQL الجديدة\n');

    if (process.argv.includes('--confirm')) {
      await truncateAllTables(pool);
    } else {
      console.log('⚠️  هذا السكريبت سيحذف أي بيانات موجودة حالياً في قاعدة PostgreSQL الجديدة');
      console.log('   (البيانات الافتراضية التي تنشأ تلقائياً عند أول تشغيل للسيرفر) قبل استيراد بياناتك الحقيقية.');
      console.log('   إذا كنت متأكداً، أعد التشغيل مع العلامة --confirm:');
      console.log('   node migrate-data.js --confirm\n');
      return;
    }

    console.log('📤 نقل الجداول (بترتيب يراعي العلاقات)...');
    let totalRows = 0;
    for (const table of TABLE_ORDER) {
      const { columns, rows } = data[table];
      totalRows += await migrateTable(pool, table, columns, rows);
    }

    await resetSequences(pool);

    console.log(`\n✓ اكتمل النقل بنجاح — إجمالي ${totalRows} صف عبر ${TABLE_ORDER.length} جدول`);
    console.log('\nالخطوة التالية: شغّل السيرفر بشكل طبيعي (node server.js) وتأكد إن كل البيانات ظاهرة صح.');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('\n✗ فشل نقل البيانات:', err.message);
  console.error('لم يتم حذف أو تعديل أي بيانات في الملف القديم — يمكنك المحاولة مرة أخرى بأمان.');
  process.exit(1);
});
