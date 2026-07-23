// db/schema.js
const { run, get } = require('./database');

async function createSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'sales', 'warehouse')),
      is_active INTEGER NOT NULL DEFAULT 1,
      can_view_cost_price INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      barcode TEXT UNIQUE,
      name TEXT NOT NULL,
      name_en TEXT,
      category_id INTEGER,
      unit TEXT NOT NULL DEFAULT 'piece' CHECK(unit IN ('piece', 'meter', 'liter', 'kg', 'set')),
      allow_fractional_qty INTEGER NOT NULL DEFAULT 0,
      cost_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      sale_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      min_stock_threshold DOUBLE PRECISION NOT NULL DEFAULT 0,
      description TEXT,
      image_path TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'warehouse' CHECK(type IN ('warehouse', 'showroom')),
      address TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_id, location_id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL CHECK(movement_type IN ('in', 'out', 'transfer_in', 'transfer_out', 'adjustment', 'initial')),
      quantity DOUBLE PRECISION NOT NULL,
      quantity_before DOUBLE PRECISION NOT NULL,
      quantity_after DOUBLE PRECISION NOT NULL,
      reference_type TEXT,
      reference_id INTEGER,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id SERIAL PRIMARY KEY,
      transfer_number TEXT NOT NULL UNIQUE,
      from_location_id INTEGER NOT NULL,
      to_location_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'cancelled')),
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (from_location_id) REFERENCES locations(id),
      FOREIGN KEY (to_location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id SERIAL PRIMARY KEY,
      transfer_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // ===================== جدول صلاحيات المواقع لكل مستخدم =====================
  // admin دائماً يشوف كل المواقع (مش محتاج صفوف هنا)
  // غير الـ admin — يشوف فقط المواقع المحددة له في هذا الجدول
  // لو مفيش صفوف للمستخدم هنا: يشوف كل المواقع (fallback للتوافقية)
  await run(`
    CREATE TABLE IF NOT EXISTS user_location_permissions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      UNIQUE(user_id, location_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
    );
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory(product_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_inventory_location ON inventory(location_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_user_loc_perms ON user_location_permissions(user_id);`);

  console.log('✓ تم إنشاء/تحديث مخطط قاعدة البيانات بنجاح');
}

async function seedInitialData() {
  const bcrypt = require('bcryptjs');
  const adminExists = await get(`SELECT id FROM users WHERE username = 'admin'`);
  if (!adminExists) {
    const passwordHash = bcrypt.hashSync('admin123', 10);
    await run(
      `INSERT INTO users (full_name, username, password_hash, role, can_view_cost_price) VALUES (?, ?, ?, ?, ?)`,
      ['مدير النظام', 'admin', passwordHash, 'admin', 1]
    );
    console.log('✓ تم إنشاء مستخدم Admin افتراضي (username: admin / password: admin123)');
  }

  const locationsExist = await get(`SELECT id FROM locations LIMIT 1`);
  if (!locationsExist) {
    const defaultLocations = [
      ['المستودع الرئيسي', 'warehouse'],
      ['المستودع الثاني', 'warehouse'],
      ['المستودع الثالث', 'warehouse'],
      ['المستودع الرابع', 'warehouse'],
      ['صالة العرض', 'showroom'],
    ];
    for (const [name, type] of defaultLocations) {
      await run(`INSERT INTO locations (name, type) VALUES (?, ?)`, [name, type]);
    }
    console.log('✓ تم إنشاء المواقع الافتراضية (٤ مستودعات + صالة عرض)');
  }

  const categoriesExist = await get(`SELECT id FROM categories LIMIT 1`);
  if (!categoriesExist) {
    for (const name of ['نجف كريستال','نجف ديكوري','سبوت لايت LED','كشافات','لمبات','إكسسوارات إضاءة']) {
      await run(`INSERT INTO categories (name) VALUES (?)`, [name]);
    }
    console.log('✓ تم إنشاء التصنيفات الافتراضية');
  }
}

module.exports = { createSchema, seedInitialData };

// ═══════════════════════════════════════════════════════
//  المرحلة الثانية — الموردون والمشتريات
// ═══════════════════════════════════════════════════════

async function createProcurementSchema() {
  // ─── الموردون ───
  await run(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      name_en TEXT,
      type TEXT NOT NULL DEFAULT 'company' CHECK(type IN ('company','individual')),
      phone TEXT,
      phone2 TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      country TEXT DEFAULT 'مصر',
      tax_number TEXT,
      commercial_register TEXT,
      contact_person TEXT,
      contact_phone TEXT,
      payment_terms INTEGER DEFAULT 30,
      credit_limit DOUBLE PRECISION DEFAULT 0,
      opening_balance DOUBLE PRECISION DEFAULT 0,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─── علاقات الموردين ذوي الصلة ───
  await run(`
    CREATE TABLE IF NOT EXISTS supplier_relations (
      id SERIAL PRIMARY KEY,
      supplier_id INTEGER NOT NULL,
      related_supplier_id INTEGER NOT NULL,
      relation_type TEXT DEFAULT 'related',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(supplier_id, related_supplier_id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
      FOREIGN KEY (related_supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    );
  `);

  // ─── أوامر الشراء (Purchase Orders) ───
  await run(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id SERIAL PRIMARY KEY,
      po_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','sent','partial','received','cancelled')),
      order_date TEXT NOT NULL DEFAULT (date('now')),
      expected_date TEXT,
      location_id INTEGER,
      subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
      discount_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      tax_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      total DOUBLE PRECISION NOT NULL DEFAULT 0,
      paid_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── بنود أمر الشراء ───
  await run(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id SERIAL PRIMARY KEY,
      po_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      location_id INTEGER,
      qty_ordered DOUBLE PRECISION NOT NULL,
      qty_received DOUBLE PRECISION NOT NULL DEFAULT 0,
      unit_cost DOUBLE PRECISION NOT NULL,
      discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      line_total DOUBLE PRECISION NOT NULL,
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );
  `);

  // ─── إيصالات الاستلام (Goods Receipts) ───
  await run(`
    CREATE TABLE IF NOT EXISTS purchase_receipts (
      id SERIAL PRIMARY KEY,
      receipt_number TEXT NOT NULL UNIQUE,
      po_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      receipt_date TEXT NOT NULL DEFAULT (date('now')),
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS purchase_receipt_items (
      id SERIAL PRIMARY KEY,
      receipt_id INTEGER NOT NULL,
      po_item_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      location_id INTEGER,
      qty_received DOUBLE PRECISION NOT NULL,
      unit_cost DOUBLE PRECISION NOT NULL,
      FOREIGN KEY (receipt_id) REFERENCES purchase_receipts(id) ON DELETE CASCADE,
      FOREIGN KEY (po_item_id) REFERENCES purchase_order_items(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );
  `);

  // ─── مدفوعات الموردين ───
  await run(`
    CREATE TABLE IF NOT EXISTS supplier_payments (
      id SERIAL PRIMARY KEY,
      payment_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL,
      po_id INTEGER,
      amount DOUBLE PRECISION NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash'
        CHECK(payment_method IN ('cash','bank_transfer','cheque','other')),
      payment_date TEXT NOT NULL DEFAULT (date('now')),
      reference TEXT,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── جدول الأقساط ───
  await run(`
    CREATE TABLE IF NOT EXISTS payment_installments (
      id SERIAL PRIMARY KEY,
      supplier_id INTEGER NOT NULL,
      po_id INTEGER,
      installment_number INTEGER NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      due_date TEXT NOT NULL,
      paid_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','partial','paid','overdue')),
      payment_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
      FOREIGN KEY (payment_id) REFERENCES supplier_payments(id)
    );
  `);

  // ─── فهارس ───
  await run(`CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_po_status   ON purchase_orders(status);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_payments_supplier ON supplier_payments(supplier_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_installments_due  ON payment_installments(due_date);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_installments_status ON payment_installments(status);`);

  console.log('✓ تم إنشاء جداول المرحلة الثانية (الموردون والمشتريات)');
}

module.exports.createProcurementSchema = createProcurementSchema;

// ═══════════════════════════════════════════════════════
//  المرحلة الثالثة — المبيعات والعملاء والتقسيط والمردودات
// ═══════════════════════════════════════════════════════

// ─── ترحيل: إضافة location_id لبنود أوامر الشراء وإيصالات الاستلام ───
// (لدعم تحديد مخزن استلام مختلف لكل منتج داخل نفس أمر الشراء، تماماً
// زي ما هو متاح بالفعل في بنود فاتورة البيع)
async function migrateProcurementSchema() {
  const col1 = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'purchase_order_items' AND column_name = 'location_id'`
  );
  if (!col1) {
    await run(`ALTER TABLE purchase_order_items ADD COLUMN location_id INTEGER REFERENCES locations(id);`);
    console.log('✓ ترحيل: تمت إضافة عمود location_id لجدول purchase_order_items');
  }

  const col2 = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'purchase_receipt_items' AND column_name = 'location_id'`
  );
  if (!col2) {
    await run(`ALTER TABLE purchase_receipt_items ADD COLUMN location_id INTEGER REFERENCES locations(id);`);
    console.log('✓ ترحيل: تمت إضافة عمود location_id لجدول purchase_receipt_items');
  }

  await run(`CREATE INDEX IF NOT EXISTS idx_po_items_location ON purchase_order_items(location_id);`);
}

module.exports.migrateProcurementSchema = migrateProcurementSchema;

// ─── ترحيل: تنبيهات المخزون المنخفض — نمطين (المرحلة 3 من خطة الـ ERP) ───
// Mode A (افتراضي، متوافق مع كل المنتجات الحالية): حد تنبيه واحد يقارن
// بإجمالي الكمية عبر كل المخازن (نفس السلوك الحالي تماماً، بدون أي تغيير).
// Mode B (اختياري لكل منتج): حد تنبيه مستقل لكل مخزن على حدة، في جدول
// منفصل بدل تكديس أعمدة لكل مخزن على جدول المنتجات (تصميم يتحمّل أي عدد
// من المخازن يتضاف مستقبلاً من غير أي تعديل في الـ schema تاني).
async function migrateInventoryAlertsSchema() {
  const col = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'products' AND column_name = 'low_stock_mode'`
  );
  if (!col) {
    await run(`ALTER TABLE products ADD COLUMN low_stock_mode TEXT NOT NULL DEFAULT 'global';`);
    console.log('✓ ترحيل: تمت إضافة عمود low_stock_mode لجدول products');
  }

  await run(`
    CREATE TABLE IF NOT EXISTS product_location_thresholds (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      min_stock_threshold NUMERIC NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_id, location_id)
    );
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_plt_product ON product_location_thresholds(product_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_plt_location ON product_location_thresholds(location_id);`);
}
module.exports.migrateInventoryAlertsSchema = migrateInventoryAlertsSchema;

// ─── ترحيل: استكمال دورة المشتريات (المرحلة 5) ───
// - purchase_orders.purchase_type: نقدي / تقسيط — نفس مبدأ payment_type
//   بالفواتير، بيحدد هل أمر الشراء يتسوّى فوراً بدفعة واحدة ولا بجدول أقساط.
// - supplier_payments.proof_image_path: إثبات الدفع (صورة) لطرق الدفع
//   الإلكترونية — إلزامي عند التسجيل لأي طريقة غير "نقدي" (يتحقق منه في
//   الراوت، مش في الـ DB، عشان رسالة خطأ واضحة للمستخدم).
// - توسيع قائمة طرق الدفع المسموحة لتشمل فودافون كاش وInstaPay.
async function migratePurchasingSchema() {
  const poTypeCol = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'purchase_orders' AND column_name = 'purchase_type'`
  );
  if (!poTypeCol) {
    await run(`ALTER TABLE purchase_orders ADD COLUMN purchase_type TEXT NOT NULL DEFAULT 'cash';`);
    console.log('✓ ترحيل: تمت إضافة عمود purchase_type لجدول purchase_orders');
  }

  const proofCol = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'supplier_payments' AND column_name = 'proof_image_path'`
  );
  if (!proofCol) {
    await run(`ALTER TABLE supplier_payments ADD COLUMN proof_image_path TEXT;`);
    console.log('✓ ترحيل: تمت إضافة عمود proof_image_path لجدول supplier_payments');
  }

  // توسيع الـ CHECK constraint على payment_method (لو لسه بالقائمة القديمة)
  let constraintCheck = null;
  try {
    constraintCheck = await get(`
      SELECT pg_get_constraintdef(oid) as def FROM pg_constraint
      WHERE conrelid = 'supplier_payments'::regclass AND contype = 'c' AND conname LIKE '%payment_method%'
    `);
  } catch (e) { /* لو الاستعلام فشل لأي سبب، نتجاهل توسيع الـ constraint بأمان */ }
  if (constraintCheck && !constraintCheck.def.includes('vodafone_cash')) {
    await run(`ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_payment_method_check;`);
    await run(`ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_payment_method_check
      CHECK(payment_method IN ('cash','bank_transfer','cheque','vodafone_cash','instapay','other'));`);
    console.log('✓ ترحيل: تم توسيع طرق الدفع المسموحة في supplier_payments');
  }
}
module.exports.migratePurchasingSchema = migratePurchasingSchema;

// ─── ترحيل: التحصيل بالمحافظة/المنطقة (المرحلة 6) ───
// عمودين جدد بس على جدول customers، بدون أي مساس بعمود city الموجود من
// زمان (city فضل زي ما هو لأي استخدام قديم)، وبتوافق كامل مع العملاء
// الحاليين (قيمة NULL افتراضية = "غير محدد"، هيظهروا في تقرير التحصيل
// تحت تصنيف "بدون محافظة محددة" لحد ما حد يحدّثهم).
async function migrateCollectionSchema() {
  const govCol = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'customers' AND column_name = 'governorate'`
  );
  if (!govCol) {
    await run(`ALTER TABLE customers ADD COLUMN governorate TEXT;`);
    console.log('✓ ترحيل: تمت إضافة عمود governorate لجدول customers');
  }

  const areaCol = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'customers' AND column_name = 'area'`
  );
  if (!areaCol) {
    await run(`ALTER TABLE customers ADD COLUMN area TEXT;`);
    console.log('✓ ترحيل: تمت إضافة عمود area لجدول customers');
  }

  await run(`CREATE INDEX IF NOT EXISTS idx_customers_governorate ON customers(governorate);`);
}
module.exports.migrateCollectionSchema = migrateCollectionSchema;

// ─── ترحيل: نظام التنبيهات الموحّد على تليجرام (المرحلة 7) ───
async function migrateNotificationsSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id SERIAL PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_notification_log_type ON notification_log(event_type);`);

  const enabledCol = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'settings' AND column_name = 'notifications_enabled'`
  );
  if (!enabledCol) {
    await run(`ALTER TABLE settings ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1;`);
    console.log('✓ ترحيل: تمت إضافة عمود notifications_enabled لجدول settings');
  }

  const reminderCol = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'settings' AND column_name = 'installment_reminder_days'`
  );
  if (!reminderCol) {
    await run(`ALTER TABLE settings ADD COLUMN installment_reminder_days INTEGER NOT NULL DEFAULT 1;`);
    console.log('✓ ترحيل: تمت إضافة عمود installment_reminder_days لجدول settings');
  }

  const lowStockCol = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'settings' AND column_name = 'notify_low_stock'`
  );
  if (!lowStockCol) {
    await run(`ALTER TABLE settings ADD COLUMN notify_low_stock INTEGER NOT NULL DEFAULT 1;`);
    console.log('✓ ترحيل: تمت إضافة عمود notify_low_stock لجدول settings');
  }
}
module.exports.migrateNotificationsSchema = migrateNotificationsSchema;

// ─── ترحيل: احتراف نظام مردودات المبيعات (Returns / RMA) ───
// - سابقاً return_type كان يدعم 'repair' في الـ schema بس من غير أي منطق
//   عمل فعلي مختلف عن الاسترداد النقدي العادي — وده كان بيسبب باج حقيقي:
//   منتج "تحت الإصلاح" كان بيترجع للمخزون القابل للبيع فوراً وكأنه سليم!
// - store_credit: نوع مرتجع جديد — بدل استرداد نقدي فوري، المبلغ بيتحول
//   لرصيد دائن للعميل يُستخدم في أي فاتورة قادمة (بديل "قسيمة الإرجاع"
//   في متاجر السلاسل الكبرى).
async function migrateReturnsSchema() {
  const cols = [
    ['sales_returns', 'expected_return_date', `TEXT`],
    ['sales_returns', 'repair_status', `TEXT NOT NULL DEFAULT 'none'`],
    ['sales_returns', 'exchange_invoice_id', `INTEGER REFERENCES invoices(id)`],
    ['customers', 'store_credit_balance', `DOUBLE PRECISION NOT NULL DEFAULT 0`],
  ];
  for (const [table, col, type] of cols) {
    const exists = await get(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${col}'`
    );
    if (!exists) {
      await run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`);
      console.log(`✓ ترحيل: تمت إضافة عمود ${col} لجدول ${table}`);
    }
  }

  // توسيع return_type ليشمل store_credit
  try {
    const constraintCheck = await get(`
      SELECT pg_get_constraintdef(oid) as def FROM pg_constraint
      WHERE conrelid = 'sales_returns'::regclass AND contype = 'c' AND conname LIKE '%return_type%'
    `);
    if (constraintCheck && !constraintCheck.def.includes('store_credit')) {
      await run(`ALTER TABLE sales_returns DROP CONSTRAINT IF EXISTS sales_returns_return_type_check;`);
      await run(`ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_return_type_check
        CHECK(return_type IN ('refund','exchange','repair','store_credit'));`);
      console.log('✓ ترحيل: تم توسيع أنواع المرتجعات لتشمل رصيد الإرجاع (store_credit)');
    }
  } catch (e) { /* لو فشل الفحص، نتجاهل بأمان — العمود الأساسي مش متأثر */ }

  // توسيع طريقة دفع العميل لتشمل استخدام رصيد المرتجعات (store_credit) —
  // يغلق الحلقة: العميل ياخد رصيد من مرتجع، ويقدر يستخدمه فعلياً في فاتورة جديدة
  try {
    const payMethodCheck = await get(`
      SELECT pg_get_constraintdef(oid) as def FROM pg_constraint
      WHERE conrelid = 'customer_payments'::regclass AND contype = 'c' AND conname LIKE '%payment_method%'
    `);
    if (payMethodCheck && !payMethodCheck.def.includes('store_credit')) {
      await run(`ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_payment_method_check;`);
      await run(`ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_payment_method_check
        CHECK(payment_method IN ('cash','bank_transfer','cheque','card','other','store_credit'));`);
      console.log('✓ ترحيل: تم توسيع طرق دفع العميل لتشمل رصيد المرتجعات');
    }
  } catch (e) { /* تجاهل بأمان */ }
}
module.exports.migrateReturnsSchema = migrateReturnsSchema;

async function createSalesSchema() {
  // ─── العملاء ───
  await run(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      name_en TEXT,
      type TEXT NOT NULL DEFAULT 'retail'
        CHECK(type IN ('retail','wholesale','vip','contractor')),
      phone TEXT,
      phone2 TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      country TEXT DEFAULT 'مصر',
      tax_number TEXT,
      contact_person TEXT,
      discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      credit_limit DOUBLE PRECISION DEFAULT 0,
      payment_terms INTEGER DEFAULT 0,
      opening_balance DOUBLE PRECISION DEFAULT 0,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─── الفواتير ───
  await run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      location_id INTEGER,
      invoice_date TEXT NOT NULL DEFAULT (date('now')),
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','confirmed','partial','paid','cancelled','refunded')),
      payment_type TEXT NOT NULL DEFAULT 'cash'
        CHECK(payment_type IN ('cash','credit','installment')),
      subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
      discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      discount_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      tax_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      tax_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      total DOUBLE PRECISION NOT NULL DEFAULT 0,
      paid_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      notes TEXT,
      notes_en TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── بنود الفاتورة ───
  await run(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      unit_price DOUBLE PRECISION NOT NULL,
      discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
      line_total DOUBLE PRECISION NOT NULL,
      returned_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // ─── مدفوعات العملاء ───
  await run(`
    CREATE TABLE IF NOT EXISTS customer_payments (
      id SERIAL PRIMARY KEY,
      payment_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      invoice_id INTEGER,
      amount DOUBLE PRECISION NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash'
        CHECK(payment_method IN ('cash','bank_transfer','cheque','card','other')),
      payment_date TEXT NOT NULL DEFAULT (date('now')),
      reference TEXT,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── أقساط العملاء ───
  await run(`
    CREATE TABLE IF NOT EXISTS customer_installments (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      installment_number INTEGER NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      due_date TEXT NOT NULL,
      paid_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','partial','paid','overdue')),
      payment_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (payment_id) REFERENCES customer_payments(id)
    );
  `);

  // ─── مردودات المبيعات ───
  await run(`
    CREATE TABLE IF NOT EXISTS sales_returns (
      id SERIAL PRIMARY KEY,
      return_number TEXT NOT NULL UNIQUE,
      invoice_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      return_date TEXT NOT NULL DEFAULT (date('now')),
      return_type TEXT NOT NULL DEFAULT 'refund'
        CHECK(return_type IN ('refund','exchange','repair')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','completed','rejected')),
      total_refund DOUBLE PRECISION NOT NULL DEFAULT 0,
      reason TEXT,
      notes TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sales_return_items (
      id SERIAL PRIMARY KEY,
      return_id INTEGER NOT NULL,
      invoice_item_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      unit_price DOUBLE PRECISION NOT NULL,
      condition TEXT DEFAULT 'good'
        CHECK(condition IN ('good','damaged','repair')),
      restock INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (return_id) REFERENCES sales_returns(id) ON DELETE CASCADE,
      FOREIGN KEY (invoice_item_id) REFERENCES invoice_items(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // ─── فهارس ───
  await run(`CREATE INDEX IF NOT EXISTS idx_invoices_customer  ON invoices(customer_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_invoices_status    ON invoices(status);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_invoices_date      ON invoices(invoice_date);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cust_pay_customer  ON customer_payments(customer_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cust_inst_due      ON customer_installments(due_date);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cust_inst_status   ON customer_installments(status);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_returns_invoice    ON sales_returns(invoice_id);`);

  await migrateSalesSchema();

  console.log('✓ تم إنشاء جداول المرحلة الثالثة (المبيعات والعملاء)');
}

// ─── ترحيلات (Migrations) خفيفة على جداول موجودة بالفعل ───
// نفحص information_schema.columns (مكافئ PRAGMA table_info في SQLite) قبل
// أي ALTER TABLE، عشان السيرفر يقدر يعيد التشغيل من غير ما يحاول يضيف نفس
// العمود مرتين ويرمي error.
async function migrateSalesSchema() {
  // بند الفاتورة: نضيف location_id عشان كل بند يقدر يتباع من مخزن مختلف عن باقي
  // بنود نفس الفاتورة (دعم تعدد المخازن داخل فاتورة واحدة في نفس الوقت).
  const col = await get(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'invoice_items' AND column_name = 'location_id'`
  );
  if (!col) {
    await run(`ALTER TABLE invoice_items ADD COLUMN location_id INTEGER REFERENCES locations(id);`);
    console.log('✓ ترحيل: تمت إضافة عمود location_id لجدول invoice_items');
  }
  await run(`CREATE INDEX IF NOT EXISTS idx_invoice_items_location ON invoice_items(location_id);`);
}

module.exports.createSalesSchema = createSalesSchema;

// ═══════════════════════════════════════════════════════════════
// المرحلة الرابعة — المصروفات، العمولات، التقارير، لوحة التحكم
// ═══════════════════════════════════════════════════════════════
async function createPhase4Schema() {
  // ─── إعدادات الشركة (صف واحد ثابت id=1) ───
  // تُستخدم في رأس الفاتورة (طباعة/PDF)، رسائل واتساب، وشريط النظام الجانبي،
  // بدلاً من كتابة اسم/عنوان/هاتف الشركة كنص ثابت متكرر في عدة أماكن بالكود.
  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      company_name TEXT NOT NULL DEFAULT 'مؤسسة الرفاعي للنجف والاضاءة',
      company_name_en TEXT DEFAULT 'Al-Rifai Chandeliers & Lighting',
      slogan TEXT DEFAULT 'النجف الديكوري — كريستال — LED',
      address TEXT DEFAULT 'العنوان، المحافظة، مصر',
      phone TEXT DEFAULT '01X-XXXX-XXXX',
      phone2 TEXT,
      email TEXT,
      tax_number TEXT,
      commercial_register TEXT,
      invoice_footer_note TEXT DEFAULT 'شكراً لثقتكم بنا',
      currency_symbol TEXT NOT NULL DEFAULT 'ج.م',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─── تصنيفات المصروفات ───
  await run(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─── المصروفات التشغيلية ───
  await run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      expense_number TEXT NOT NULL UNIQUE,
      category_id INTEGER NOT NULL,
      location_id INTEGER,
      amount DOUBLE PRECISION NOT NULL CHECK(amount > 0),
      expense_date TEXT NOT NULL DEFAULT (date('now')),
      payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash','bank','cheque','other')),
      is_recurring INTEGER NOT NULL DEFAULT 0,
      recurrence_period TEXT CHECK(recurrence_period IN ('weekly','monthly','yearly') OR recurrence_period IS NULL),
      vendor_name TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('pending','approved','rejected')),
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES expense_categories(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── قواعد العمولات ───
  // user_id = NULL تعني "القاعدة الافتراضية" التي تُطبَّق على أي مندوب مبيعات
  // ليس له قاعدة خاصة به.
  await run(`
    CREATE TABLE IF NOT EXISTS commission_rules (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE,
      rule_type TEXT NOT NULL DEFAULT 'pct_profit' CHECK(rule_type IN ('pct_sales','pct_profit','fixed_per_invoice')),
      rate DOUBLE PRECISION NOT NULL DEFAULT 0,
      min_invoice_total DOUBLE PRECISION NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // ─── سجلات العمولات (تُولَّد تلقائياً عند تأكيد كل فاتورة) ───
  await run(`
    CREATE TABLE IF NOT EXISTS commissions (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      rule_id INTEGER,
      base_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      rate DOUBLE PRECISION NOT NULL DEFAULT 0,
      commission_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled')),
      paid_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (rule_id) REFERENCES commission_rules(id)
    );
  `);

  // ─── فهارس أداء إضافية (على جداول قائمة فعلاً من مراحل سابقة) ───
  // بدون هذه لن تُبطئ الفهارس شيئاً موجوداً، فقط تُسرّع استعلامات التقارير
  // الجديدة (فرز/تجميع كبير الحجم على المخزون والمشتريات).
  await run(`CREATE INDEX IF NOT EXISTS idx_invoice_items_product      ON invoice_items(product_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_stock_movements_product    ON stock_movements(product_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_stock_movements_created    ON stock_movements(created_at);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_pid ON purchase_receipt_items(product_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_expenses_date              ON expenses(expense_date);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_expenses_category          ON expenses(category_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_commissions_user           ON commissions(user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_commissions_status         ON commissions(status);`);

  seedPhase4Data();

  console.log('✓ تم إنشاء جداول المرحلة الرابعة (المصروفات والعمولات والتقارير)');
}

// ─── بيانات أولية للمرحلة الرابعة ───
async function seedPhase4Data() {
  const settingsRow = await get(`SELECT id FROM settings WHERE id = 1`);
  if (!settingsRow) {
    await run(`INSERT INTO settings (id, company_name, company_name_en, slogan, address, phone)
         VALUES (1, 'مؤسسة الرفاعي للنجف والاضاءة', 'Al-Rifai Chandeliers & Lighting',
                 'النجف الديكوري — كريستال — LED', 'العنوان، المحافظة، مصر', '01X-XXXX-XXXX')`);
  }

  const catCount = await get(`SELECT COUNT(*) as c FROM expense_categories`);
  if (!catCount || catCount.c === 0) {
    const defaults = ['رواتب وأجور', 'إيجار', 'كهرباء ومياه', 'صيانة', 'تسويق وإعلان', 'شحن ونقل', 'مصروفات إدارية', 'أخرى'];
    for (const name of defaults) {
      await run(`INSERT INTO expense_categories (name) VALUES (?)`, [name]);
    }
  }

  // قاعدة عمولة افتراضية (غير مفعّلة حتى يضبطها المدير من شاشة الإعدادات)
  const defaultRule = await get(`SELECT id FROM commission_rules WHERE user_id IS NULL`);
  if (!defaultRule) {
    await run(`INSERT INTO commission_rules (user_id, rule_type, rate, is_active) VALUES (NULL, 'pct_profit', 5, 0)`);
  }
}

// ─── فهارس أداء إضافية (Stage 5 — QA/Performance) ───
// لوحظ عند مراجعة الأداء إن أعمدة مفتاح أجنبي (FK) كتير بتتفلتر/تتربط
// عليها في استعلامات متكررة جداً (كل فتح فاتورة، كل استلام، كل تقرير...)
// من غير أي index مطابق، فبتعمل full table scan بمجرد ما البيانات تكبر.
// أهمها invoice_items.invoice_id لأنه بيتقرا في كل عرض/طباعة/تأكيد فاتورة.
// آمن يتنفذ كل مرة يشتغل السيرفر (CREATE INDEX IF NOT EXISTS).
async function migratePerformanceIndexes() {
  await run(`CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice        ON invoice_items(invoice_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cust_inst_invoice            ON customer_installments(invoice_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cust_inst_customer           ON customer_installments(customer_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_pay_inst_po                  ON payment_installments(po_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_pay_inst_supplier            ON payment_installments(supplier_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_po_items_po                  ON purchase_order_items(po_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt        ON purchase_receipt_items(receipt_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_receipt_items_po_item        ON purchase_receipt_items(po_item_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_supplier_payments_po         ON supplier_payments(po_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_customer_payments_invoice    ON customer_payments(invoice_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_stock_movements_location     ON stock_movements(location_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_log_user               ON audit_log(user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_log_entity             ON audit_log(entity_type, entity_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_log_created            ON audit_log(created_at);`);
  console.log('✓ تم التأكد من فهارس الأداء الإضافية (Stage 5)');
}

module.exports.createPhase4Schema = createPhase4Schema;
module.exports.migratePerformanceIndexes = migratePerformanceIndexes;