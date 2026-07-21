// db/database.js
// طبقة قاعدة البيانات - تستخدم sql.js (SQLite مبني بـ WebAssembly، لا يحتاج أي compilation)
// يتم تحميل القاعدة بالكامل في الذاكرة، ويتم حفظها على القرص (data/erp.sqlite) بعد كل عملية كتابة

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/erp.sqlite');

let SQL = null;
let db = null;
let inTransaction = false;

// حفظ القاعدة بالكامل على القرص
// ننشئ مجلد data تلقائياً إذا لم يكن موجوداً (مهم على Windows)
function persist() {
  if (!db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// تنفيذ استعلام بدون نتائج (INSERT/UPDATE/DELETE/CREATE)
// نستخدم db.run() المدمجة في sql.js مباشرة (بدل prepare/step اليدوي) لأنها
// تحافظ على سياق الاتصال الصحيح، وهو ضروري لعمل last_insert_rowid() بشكل صحيح
function run(sql, params = []) {
  db.run(sql, params);
  if (!inTransaction) {
    persist();
  }
}

// تنفيذ استعلام والحصول على كل النتائج كمصفوفة من الكائنات
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// تنفيذ استعلام والحصول على أول نتيجة فقط
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// الحصول على آخر id تم إدخاله (لـ INSERT)
// نستخدم db.exec() مباشرة (بدل get/all القائمة على prepare) لأن هذا هو الأسلوب
// الذي يحافظ بشكل صحيح على سياق last_insert_rowid() في sql.js
function lastInsertId() {
  const result = db.exec('SELECT last_insert_rowid() as id');
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0];
}

// تنفيذ عملية INSERT والحصول على الـ id الجديد مباشرة
// ملاحظة مهمة: يجب الحصول على last_insert_rowid() مباشرة بعد التنفيذ
// وقبل استدعاء persist()/export() لأن db.export() في sql.js يُعيد تصفير هذه القيمة
function insert(sql, params = []) {
  db.run(sql, params);
  const newId = lastInsertId();
  if (!inTransaction) {
    persist();
  }
  return newId;
}

// تنفيذ مجموعة عمليات داخل transaction واحدة (لضمان تناسق البيانات)
function transaction(fn) {
  if (inTransaction) {
    // إذا كنا بالفعل داخل transaction، ننفذ الدالة مباشرة بدون BEGIN/COMMIT متداخل
    return fn();
  }

  db.run('BEGIN TRANSACTION');
  inTransaction = true;
  try {
    const result = fn();
    db.run('COMMIT');
    inTransaction = false;
    persist();
    return result;
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch (rollbackErr) {
      // تجاهل أخطاء rollback إذا لم تكن هناك transaction فعلية لإلغائها
    }
    inTransaction = false;
    throw err;
  }
}

async function initDatabase() {
  if (!SQL) {
    SQL = await initSqlJs();
  }

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('✓ تم تحميل قاعدة البيانات الموجودة');
  } else {
    db = new SQL.Database();
    console.log('✓ تم إنشاء قاعدة بيانات جديدة');
  }

  db.run('PRAGMA foreign_keys = ON;');
  return db;
}

module.exports = {
  initDatabase,
  run,
  all,
  get,
  insert,
  transaction,
  persist,
};
