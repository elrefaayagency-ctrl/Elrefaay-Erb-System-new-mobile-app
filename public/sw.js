// public/sw.js — Service Worker لنظام نجف وإضاءة ERP
//
// ═══ المبدأ الأهم في هذا الملف ═══
// أي طلب لـ /api/* (بيانات مالية/مخزون/فواتير...) بيتحول *دايماً* على
// الشبكة مباشرة، ومفيش أي تخزين مؤقت (cache) له أبداً — لا قراءة من
// الكاش ولا كتابة فيه. ده قرار متعمد وغير قابل للتفاوض: أي بيانات مالية
// قديمة معروضة للمستخدم أخطر بكتير من شاشة بيضاء وقت انقطاع النت.
// اللي بيتخزن مؤقتاً هو بس "الهيكل" (app shell): index.html نفسه،
// الأيقونات، manifest.json — يعني الواجهة تقدر تفتح أوفلاين، لكن أي
// بيانات حقيقية جوه الواجهة لازم تيجي من السيرفر دايماً.

const CACHE_VERSION = 'v1'; // ← زوّد الرقم ده مع كل نشرة فيها تغيير في الفرونت اند
const SHELL_CACHE = `erp-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `erp-runtime-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
  '/icons/icon-72.png',
  '/icons/icon-96.png',
  '/icons/icon-128.png',
  '/icons/icon-144.png',
  '/icons/icon-152.png',
  '/icons/icon-192.png',
  '/icons/icon-384.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
];

// ─── التثبيت: تخزين الـ app shell مقدماً ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  // لا نستدعي skipWaiting() هنا عمداً — نستنى موافقة المستخدم عبر واجهة
  // "تحديث جديد متاح" (شوف applyUpdate() في index.html) بدل ما نفرض
  // إعادة تحميل مفاجئة ممكن تقطع عملية إدخال بيانات لسه ما اتحفظتش.
});

// ─── التفعيل: تنظيف أي نسخ كاش قديمة من إصدارات سابقة ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── استقبال أمر "طبّق التحديث دلوقتي" من الواجهة ───
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // مفيش تدخل خالص في أي حاجة غير GET (POST/PUT/PATCH/DELETE) — كل
  // عمليات الحفظ/التعديل/الحذف المالية والمخزنية لازم تروح للشبكة
  // مباشرة بدون أي وسيط، دايماً.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // قاعدة صارمة: أي طلب API — شبكة فقط، بدون أي كاش قراءة أو كتابة
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ error: 'لا يوجد اتصال بالإنترنت — تعذّر الوصول للسيرفر' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // فقط same-origin (مش خطوط Google الخارجية مثلاً) لتفادي تعقيدات CORS
  if (url.origin !== self.location.origin) return;

  // التنقل بين الصفحات (فتح التطبيق نفسه): شبكة أولاً، مع fallback
  // للنسخة المخزنة، ثم لصفحة أوفلاين لو محصلش أي كاش
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', clone));
          return response;
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached || caches.match('/offline.html'))
        )
    );
    return;
  }

  // صور المنتجات المرفوعة: cache-first مع تحديث في الخلفية (نادراً ما
  // تتغير الصورة لنفس المنتج، والسرعة أهم من الدقة اللحظية هنا)
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const fetchPromise = fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // باقي ملفات الـ shell (manifest، أيقونات): cache-first
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
