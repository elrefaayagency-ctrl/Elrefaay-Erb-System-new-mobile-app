// server.js - نقطة الدخول الرئيسية للسيرفر
require('dotenv').config();
const express = require('express');
// express-async-errors: يعالج مشكلة أساسية في Express 4 وهي عدم التقاطه
// التلقائي للأخطاء (rejected promises) من route handlers من نوع async.
// بمجرد استيراده هنا (قبل أي app.use أو route)، أي خطأ يحصل داخل أي
// "async (req,res) => {...}" في أي ملف route عبر المشروع كله هيتحول
// تلقائياً لاستدعاء next(err) ويوصل لمعالج الأخطاء العام في أسفل هذا
// الملف — من غير الحاجة لتغليف يدوي (try/catch) في كل route على حدة.
require('express-async-errors');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./src/utils/logger');

const { initDatabase } = require('./src/db/database');
const { createSchema, seedInitialData, createProcurementSchema, migrateProcurementSchema, migrateInventoryAlertsSchema, migratePurchasingSchema, migrateCollectionSchema, migrateNotificationsSchema, migrateReturnsSchema, createSalesSchema, createPhase4Schema, migratePerformanceIndexes } = require('./src/db/schema');

const app = express();
const PORT = process.env.PORT || 5000;

// مهم جداً: السيرفر غالباً شغال خلف reverse proxy (Railway/Render/Nginx/Cloudflare)
// اللي بيستقبل الطلب عبر HTTPS ويحوّله للسيرفر عبر HTTP داخلياً.
// من غير trust proxy، Express بيفتكر إن كل طلب جايله http عادي (مش https)،
// فلما نبني رابط الصورة الكامل بـ req.protocol بيطلع http:// بينما الصفحة
// نفسها شغالة https:// → المتصفح بيرفض تحميل الصورة (Mixed Content) بصمت
// وده اللي بيسبب ظهور أيقونة placeholder بدل صورة المنتج دايماً.
app.set('trust proxy', 1);

// أمان: helmet بيضيف security headers أساسية (X-Content-Type-Options,
// X-Frame-Options, HSTS...). الـ CSP الافتراضي متقفل هنا لأن الفرونت اند
// (public/index.html) فيه inline <script> tags كتير، ولو فعّلنا CSP
// الافتراضي هيبلوك الصفحة كلها. تفعيل CSP صح محتاج فصل الـ inline scripts
// لملفات خارجية الأول — موصى بيه كخطوة لاحقة، مش في نطاق هذا الفيكس.
app.use(helmet({ contentSecurityPolicy: false }));

// أمان: حد عام لكل طلبات الـ API لمنع الإغراق (DoS بسيط) أو الاستخدام الآلي المفرط
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 600,                 // 600 طلب لكل IP كحد أقصى
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'طلبات كتير جداً من هذا العنوان، حاول تاني بعد شوية' },
});
app.use('/api', apiLimiter);

// أمان: حد صارم على تسجيل الدخول تحديداً لمنع محاولات brute-force على كلمات المرور
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 10,                  // 10 محاولات فقط لكل IP كل 15 دقيقة
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // العد بس على المحاولات الفاشلة
  message: { error: 'محاولات دخول كتير جداً، حاول تاني بعد 15 دقيقة' },
});
app.use('/api/auth/login', loginLimiter);

// CORS: لو ALLOWED_ORIGINS متعرّفة في الـ env بيتحدد الوصول للـ origins دي بس
// (الأفضل للـ production). لو مش متعرّفة، بيفضل السلوك الحالي (مفتوح للكل)
// عشان منكسرش حاجة شغالة دلوقتي بدون تنسيق مسبق مع نطاق الفرونت اند النهائي.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : {}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// تقديم الصور المرفوعة كملفات ثابتة
app.use('/uploads', express.static(path.join(__dirname, 'src/uploads')));

// تقديم الـ frontend (React build)
const publicPath = path.join(__dirname, 'public');
if (require('fs').existsSync(publicPath)) {
  // service worker: لازم Cache-Control: no-cache صريح، وإلا المتصفح ممكن
  // يستخدم نسخة قديمة مخزنة HTTP-cache من sw.js نفسه ويبطّئ اكتشاف
  // التحديثات الجديدة (مستقل تماماً عن الـ Cache API اللي sw.js نفسه بيديرها)
  app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(publicPath, 'sw.js'));
  });
  app.use(express.static(publicPath));
}

// فحص صحة السيرفر — بيتحقق فعلياً من الاتصال بقاعدة البيانات، مش بس إن
// الـ Express process شغال. مهم لأي orchestrator (Railway/Docker/PM2) عشان
// يقدر يفرّق بين "السيرفر شغال لكن مقطوع عن الداتابيز" و"كل حاجة تمام"،
// ويعيد التشغيل أو يوقف توجيه الترافيك تلقائياً في الحالة الأولى.
app.get('/api/health', async (req, res) => {
  try {
    await require('./src/db/database').get('SELECT 1 as ok');
    res.json({ status: 'ok', database: 'connected', message: 'نظام نجف وإضاءة ERP يعمل بنجاح', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected', message: 'السيرفر شغال لكن قاعدة البيانات غير متاحة', timestamp: new Date().toISOString() });
  }
});

// تسجيل المسارات (routes)
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/products', require('./src/routes/products'));
app.use('/api/categories', require('./src/routes/categories'));
app.use('/api/locations', require('./src/routes/locations'));
app.use('/api/inventory', require('./src/routes/inventory'));
app.use('/api/transfers', require('./src/routes/transfers'));
app.use('/api/import', require('./src/routes/import'));
app.use('/api/suppliers', require('./src/routes/suppliers'));
app.use('/api/purchase-orders', require('./src/routes/purchaseOrders'));
app.use('/api/purchase-receipts', require('./src/routes/purchaseReceipts'));
app.use('/api/supplier-payments', require('./src/routes/supplierPayments'));
app.use('/api/installments', require('./src/routes/installments'));
app.use('/api/customers', require('./src/routes/customers'));
app.use('/api/invoices', require('./src/routes/invoices'));
app.use('/api/invoices', require('./src/routes/invoicePdf'));
app.use('/api/customer-payments', require('./src/routes/customerPayments'));
app.use('/api/customer-installments', require('./src/routes/customerInstallments'));
app.use('/api/sales-returns', require('./src/routes/salesReturns'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/expenses', require('./src/routes/expenses'));
app.use('/api/commissions', require('./src/routes/commissions'));
app.use('/api/reports', require('./src/routes/reports'));

// التعامل مع المسارات غير الموجودة في الـ API
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'هذا المسار غير موجود' });
});

// صفحة طباعة الباركود المستقلة
app.get('/barcode-print', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'barcode-print.html'));
});

// SPA Catch-all: أي مسار غير API يُخدَّم بـ index.html (لدعم React Router)
const publicPath2 = path.join(__dirname, 'public');
if (require('fs').existsSync(publicPath2)) {
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(publicPath2, 'index.html'));
  });
}

// التعامل مع الأخطاء العامة (مثل أخطاء multer)
app.use((err, req, res, next) => {
  // logging مهيكل: بيسجّل السياق الكامل للطلب (المسار، المستخدم لو موجود)
  // مش بس الـ stack trace وحده — ضروري لتتبّع "مين عمل إيه لما حصل الخطأ"
  // في الإنتاج، خصوصاً مع أخطاء مالية أو مخزون.
  logger.error('Unhandled request error', {
    method: req.method,
    path: req.originalUrl,
    userId: req.user?.id || null,
    status: err.status || 500,
    error: err.message,
    stack: err.stack,
  });
  res.status(err.status || 500).json({ error: err.message || 'حدث خطأ غير متوقع في السيرفر' });
});

// ─── التعامل مع أخطاء على مستوى الـ process كله (كانت مفقودة تماماً) ───
// من غيرها: أي unhandledRejection (Promise مرفوض من غير catch في مكان بعيد
// عن أي route، زي جدولة دورية أو listener) كان بيتسجل تحذير بصمت من Node
// ويستمر التطبيق في حالة غير معروفة، وأي uncaughtException كان ممكن يوقف
// السيرفر فجأة من غير أي سجل يوضّح السبب. دلوقتي الاتنين بيتسجّلوا بشكل
// منظّم، وexit صريح بعد uncaughtException (حالة غير آمنة نستمر فيها) عشان
// الـ orchestrator (Railway/PM2/Docker) يعيد تشغيل عملية نضيفة تلقائياً
// بدل ما نفضل شغالين في حالة معطوبة.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || String(reason), stack: reason?.stack });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down process', { error: err.message, stack: err.stack });
  process.exit(1);
});

async function startServer() {
  try {
    await initDatabase();
    await createSchema();
    await createProcurementSchema();
    // إصلاح حرج: createSalesSchema و createPhase4Schema لازم يتنفذوا هنا
    // *قبل* migrateCollectionSchema / migrateNotificationsSchema /
    // migrateReturnsSchema، لأن الثلاثة دول بيعملوا ALTER TABLE على جداول
    // (customers, settings, customer_payments, sales_returns) متعملتش
    // إلا جوه createSalesSchema/createPhase4Schema. الترتيب القديم كان
    // شغال بالصدفة بس على قاعدة بيانات فيها الجداول دي بالفعل من نشرات
    // سابقة تراكمية — على أي قاعدة بيانات جديدة تمامًا (عميل جديد، بيئة
    // Railway/VPS جديدة) السيرفر كان هيفشل في الإقلاع تمامًا. تم اكتشافها
    // بتجربة فعلية على قاعدة بيانات فاضية أثناء تدقيق القبول النهائي.
    await createSalesSchema();
    await createPhase4Schema();
    await migrateProcurementSchema();
    await migrateInventoryAlertsSchema();
    await migratePurchasingSchema();
    await migrateCollectionSchema();
    await migrateNotificationsSchema();
    await migrateReturnsSchema();
    await migratePerformanceIndexes();
    await seedInitialData();

    // مصالحة تاريخية لأقساط اتأثرت بباج قديم (دفعات عامة ماتوزّعتش على
    // الأقساط الفردية) — آمنة تتكرر كل مرة السيرفر يشتغل، مش بس أول مرة
    await require('./src/jobs/reconcileInstallments').runInstallmentReconciliation();

    // تسجيل مستمعين الإشعارات (مرة واحدة بس، قبل أي طلب) + بدء الفحص الدوري
    require('./src/notifications/listeners');
    require('./src/jobs/notificationScheduler').startNotificationScheduler();

    app.listen(PORT, '0.0.0.0', () => {
      console.log('═══════════════════════════════════════════');
      console.log(`✓ السيرفر يعمل على المنفذ ${PORT}`);
      console.log(`✓ نظام نجف وإضاءة ERP - المراحل من الأولى إلى الرابعة`);
      console.log('═══════════════════════════════════════════');
      logger.info('Server started', { port: PORT, env: process.env.NODE_ENV || 'development' });
    });
  } catch (err) {
    logger.error('Server failed to start', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

startServer();