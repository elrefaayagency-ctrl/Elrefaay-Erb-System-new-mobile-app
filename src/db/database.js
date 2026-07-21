// db/database.js
// طبقة قاعدة البيانات — PostgreSQL (عبر Supabase أو أي مزوّد Postgres آخر)
//
// ═══════════════════════════════════════════════════════════════════════
// ملاحظة هندسية مهمة لأي مطوّر يقرأ هذا الملف لاحقاً:
// كل ملفات routes/*.js في المشروع مكتوبة بالأصل ضد SQLite (sql.js) وتستخدم:
//   - علامات استفهام (?) placeholders بدل $1,$2...
//   - دوال SQLite مثل datetime('now')، date('now','-N days')، strftime()
//   - INSERT OR IGNORE
//   - الاعتماد على last_insert_rowid() للحصول على الـ id بعد الإدخال
//
// بدل ما نُعدّل مئات استعلامات SQL الموجودة في كل ملفات routes (خطر كبير جداً
// في مشروع مالي)، هذا الملف يعمل كطبقة ترجمة (shim) شفافة: نفس التوابع
// (run/get/all/insert/transaction) بنفس الشكل، لكنها تترجم نص الاستعلام
// تلقائياً لصيغة PostgreSQL قبل التنفيذ. هذا يعني أن كل ملفات routes تبقى
// كما هي تماماً من ناحية نصوص SQL، والتغيير الوحيد المطلوب فيها هو
// إضافة async/await حول استدعاءات قاعدة البيانات (لأن Postgres، خلافاً لـ
// sql.js، يتواصل عبر الشبكة وبالتالي غير متزامن Async بطبيعته).
// ═══════════════════════════════════════════════════════════════════════

// ─── إصلاح مشكلة شائعة: AggregateError [ETIMEDOUT] عند الاتصال بـ Supabase ───
// على شبكات معيّنة (خصوصاً ويندوز مع دعم IPv6 مفعّل)، Node.js بيحاول يتصل
// بعنوان IPv6 الأول قبل IPv4، ولو الشبكة/الراوتر ما بيدعمش IPv6 بشكل سليم
// للمسار ده، الاتصال بيعلّق ويعمل timeout بعد فترة طويلة قبل ما يجرّب IPv4
// (اللي غالباً هو اللي شغال فعلاً). هذا السطر يخلي Node يفضّل عناوين IPv4
// أولاً دائماً عند حل أي اسم نطاق (DNS)، وهو الحل الرسمي الموصى به لنفس هذه
// المشكلة تحديداً مع Supabase + Node.js. لا يؤثر على أي وظيفة أخرى بالتطبيق.
try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch (_) {
  // إصدارات Node القديمة جداً (قبل 18) ما بتدعمش الدالة دي — نتجاهل بأمان
}

const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// ─── إعداد تحويل الأنواع (Type Parsing) ───
// من غير هذا، Postgres بيرجّع نوعين بيانات كـ "نص" (string) بدل رقم (number)
// في مكتبة node-pg، وده بيكسر أي عملية حسابية أو تسلسل أرقام في الكود:
//   • BIGINT (OID 20) — ده اللي بيرجعه COUNT(*) دايماً في Postgres. لو فضل
//     نص، كود زي String((r.c||0)+1) هيعمل دمج نصوص "5"+1="51" بدل جمع رقمي!
//   • NUMERIC (OID 1700) — احتياطي لو أي عمود اتحول لـ NUMERIC مستقبلاً.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
// DOUBLE PRECISION (701) و REAL (700) و INTEGER (23) بترجع كـ JS number
// تلقائياً من غير أي إعداد إضافي — وهي الأنواع المستخدمة لكل أعمدة المبالغ
// والكميات في هذا المشروع (بدل NUMERIC) بالتحديد عشان نضمن نفس سلوك
// sql.js تماماً من غير أي مفاجآت في نوع البيانات المُرجعة.

let pool = null;
const als = new AsyncLocalStorage();

function buildConnectionConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL غير موجود في متغيرات البيئة (.env). ' +
      'راجع ملف SUPABASE_MIGRATION.md للحصول على تعليمات الإعداد.'
    );
  }
  return {
    connectionString,
    // Supabase (وأغلب مزوّدي Postgres السحابيين) يتطلبون SSL. نسمح بشهادة
    // موقّعة ذاتياً (self-signed) لأن Supabase يستخدم شهادة وسيطة قد لا تكون
    // في قائمة الجذور الموثوقة الافتراضية لكل بيئة — نفس الإعداد الموصى به
    // رسمياً من Supabase لبيئات Node.js.
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
  };
}

// ─── الحصول على منفّذ الاستعلام الحالي ───
// لو إحنا جوه transaction() نستخدم نفس الـ client المحجوز (عشان تبقى كل
// الاستعلامات جزء من نفس المعاملة)، وإلا نستخدم الـ pool العام مباشرة
// (pg هيتصرف تلقائياً ويحجز/يرجّع اتصال من الـ pool لكل استعلام منفرد).
function getExecutor() {
  return als.getStore() || pool;
}

// ─── ترجمة استعلام SQLite → PostgreSQL ───
function translateSql(sql) {
  let out = sql;

  // datetime('now')  →  نص بنفس فورمات SQLite تماماً: 'YYYY-MM-DD HH:MM:SS'
  out = out.replace(/datetime\(\s*'now'\s*\)/gi, `TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')`);

  // date('now')  →  نص 'YYYY-MM-DD'
  out = out.replace(/date\(\s*'now'\s*\)(?!\s*,)/gi, `CURRENT_DATE::text`);

  // date('now','+N days')  أو  date('now','-N days'/'months'/'years')
  out = out.replace(
    /date\(\s*'now'\s*,\s*'([+-]\d+)\s*(day|days|month|months|year|years)'\s*\)/gi,
    (_, num, unit) => {
      const n = parseInt(num, 10);
      const pgUnit = unit.replace(/s$/, ''); // Postgres INTERVAL بيقبل الصيغة المفردة
      return `(CURRENT_DATE + INTERVAL '${n} ${pgUnit}')::text`;
    }
  );

  // strftime('%Y-%m', col)  →  substring نصي (الأعمدة كلها TEXT بصيغة ISO 'YYYY-MM-DD')
  out = out.replace(/strftime\(\s*'%Y-%m'\s*,\s*([a-zA-Z0-9_.]+)\s*\)/gi, `SUBSTRING($1 FROM 1 FOR 7)`);
  out = out.replace(/strftime\(\s*'%Y'\s*,\s*([a-zA-Z0-9_.]+)\s*\)/gi, `SUBSTRING($1 FROM 1 FOR 4)`);

  // INSERT OR IGNORE INTO  →  INSERT INTO ... ON CONFLICT DO NOTHING
  // (الجداول المستخدمة معها عندها بالفعل UNIQUE constraint مطابق، فالسلوك
  //  مطابق تماماً لـ SQLite: تجاهل صامت لو الصف مكرر)
  let appendConflictClause = false;
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(out)) {
    out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    appendConflictClause = true;
  }

  // تحويل علامات الاستفهام (?) إلى $1, $2, ... بترتيب ظهورها
  // (لا نلمس أي ? داخل نص محارف '...' لتفادي أي تصادم، لكن هذا المشروع
  //  لا يحتوي على ? حرفية داخل نصوص SQL أصلاً — تم التحقق يدوياً)
  let i = 0;
  out = out.replace(/\?/g, () => `$${++i}`);

  if (appendConflictClause) {
    out = out.trim().replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }

  return out;
}

// ─── تنفيذ استعلام بدون نتائج (UPDATE/DELETE/CREATE/ALTER) ───
async function run(sql, params = []) {
  const text = translateSql(sql);
  await getExecutor().query(text, params);
}

// ─── تنفيذ استعلام وإرجاع كل الصفوف كمصفوفة كائنات ───
async function all(sql, params = []) {
  const text = translateSql(sql);
  const result = await getExecutor().query(text, params);
  return result.rows;
}

// ─── تنفيذ استعلام وإرجاع أول صف فقط (أو null) ───
async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ─── تنفيذ INSERT وإرجاع الـ id الجديد مباشرة ───
// بدل الاعتماد على last_insert_rowid() (خاص بـ SQLite)، نضيف RETURNING id
// تلقائياً لأي استعلام INSERT ما لم يكن يحتوي بالفعل على RETURNING صريح.
async function insert(sql, params = []) {
  let text = translateSql(sql);
  if (!/\bRETURNING\b/i.test(text)) {
    text = text.trim().replace(/;?\s*$/, '') + ' RETURNING id';
  }
  const result = await getExecutor().query(text, params);
  // في حالة INSERT ... ON CONFLICT DO NOTHING اللي اتجاهلت (تعارض)، مفيش صف راجع
  return result.rows.length > 0 ? result.rows[0].id : null;
}

// ─── تنفيذ مجموعة عمليات داخل معاملة واحدة (Transaction) ───
// نستخدم AsyncLocalStorage لضمان إن كل استدعاءات run/get/all/insert جوه fn
// بتستخدم نفس اتصال قاعدة البيانات (نفس الـ client) بدل ما يسحب كل استعلام
// اتصال عشوائي مختلف من الـ pool — وهو أمر ضروري لصحة الـ transaction تحت
// أي حمل تزامن (concurrent requests)، وآمن تماماً مع طلبات متزامنة متعددة
// لأن AsyncLocalStorage بيعزل الـ context تلقائياً لكل سلسلة async مستقلة.
async function transaction(fn) {
  // معاملة متداخلة (transaction جوه transaction) — نفّذ مباشرة بنفس الـ client الحالي
  if (als.getStore()) {
    return fn();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run(client, () => fn());
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // تجاهل خطأ rollback لو الاتصال أصلاً مقطوع
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── تهيئة الاتصال بقاعدة البيانات عند بدء تشغيل السيرفر ───
async function initDatabase() {
  if (pool) return pool;

  pool = new Pool(buildConnectionConfig());

  pool.on('error', (err) => {
    // خطأ على اتصال خامل (idle) في الـ pool — نسجّله فقط، لا داعي لإسقاط
    // السيرفر بالكامل لأن pg هيحاول يعيد الاتصال تلقائياً للطلب التالي
    console.error('✗ خطأ غير متوقع في اتصال قاعدة البيانات:', err.message);
  });

  // تأكيد إن الاتصال شغال فعلاً قبل ما نكمل تشغيل السيرفر
  const testClient = await pool.connect();
  const { rows } = await testClient.query('SELECT NOW() as now, current_database() as db');
  testClient.release();
  console.log(`✓ تم الاتصال بقاعدة بيانات PostgreSQL بنجاح (${rows[0].db})`);

  return pool;
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initDatabase,
  closeDatabase,
  run,
  all,
  get,
  insert,
  transaction,
};
