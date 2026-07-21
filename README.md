# نظام نجف وإضاءة ERP — مؤسسة الرفاعي للنجف والإضاءة

نظام ERP كامل بالعربي — Node.js/Express + PostgreSQL (Supabase) + فرونت اند
JS خام، قابل للتثبيت كتطبيق سطح مكتب/موبايل (PWA). يغطي: المنتجات، المخزون متعدد المخازن، الباركود، المشتريات
والموردين، المبيعات والعملاء، الأقساط (عملاء وموردين)، المرتجعات،
الفواتير PDF (عربي/إنجليزي) وواتساب، المصروفات، العمولات، والتقارير.

## هيكل المشروع

```
server.js                 نقطة الدخول — تسجيل الـ routes + بدء التشغيل
src/
  db/                      طبقة قاعدة البيانات (Postgres) + المخطط والـ migrations
  middleware/auth.js       التوثيق (JWT) والصلاحيات
  routes/                  كل الـ API endpoints (22 ملف — منتج لكل موديول)
  utils/                   منطق عمل مشترك (الأقساط، العمولات، دفتر الأستاذ، الطباعة، تيليجرام...)
  jobs/                    مهام دورية (مصالحة الأقساط، جدولة التنبيهات)
  notifications/           نظام الأحداث والإشعارات (تيليجرام)
  uploads/                 صور المنتجات وإثباتات الدفع المرفوعة (لازم تتحفظ خارج الكونتينر)
public/                    الفرونت اند (SPA بملف HTML واحد + build سابق)
deploy/                    كل ملفات النشر والنسخ الاحتياطي (تفاصيل تحت)
```

## التركيب المحلي (Development)

```bash
npm install
cp .env.example .env     # املأ DATABASE_URL و JWT_SECRET على الأقل
npm run dev               # يعيد التشغيل تلقائياً عند أي تعديل
```
السيرفر هيشتغل على `http://localhost:5000` (أو الـ PORT اللي في .env).
أول تشغيل بينشئ الجداول تلقائياً + مستخدم admin افتراضي
(`admin` / `admin123` — **غيّر الباسورد ده فوراً بعد أول دخول**).

## النشر (Deployment)

| المنصة | الطريقة | التفاصيل |
|---|---|---|
| Railway | تلقائي عبر `railway.json` (Nixpacks) | اضبط متغيرات البيئة من `.env.example` في Railway Dashboard، ثم push |
| VPS (Docker) | `docker compose up -d --build` | `docker-compose.yml` + `Dockerfile` + `deploy/nginx.conf` |
| VPS (بدون Docker) | PM2 | `pm2 start deploy/ecosystem.config.js` |

**قبل أي نشر إنتاجي:**
1. `JWT_SECRET` لازم يكون عشوائي 32+ حرف (السيرفر يرفض يشتغل من غيره — أمان مقصود)
2. راجع `.env.example` لكل المتغيرات المطلوبة
3. لو Docker/VPS: راجع `deploy/nginx.conf` وغيّر `server_name` للنطاق الحقيقي
4. اضبط النسخ الاحتياطي — شوف `deploy/BACKUP_GUIDE.md`

## النسخ الاحتياطي والاستعادة

راجع `deploy/BACKUP_GUIDE.md` — يشرح استراتيجية Supabase التلقائي +
`deploy/backup.sh`/`deploy/restore.sh` المحليين، والفرق بين Railway وVPS.

## فحص الصحة (Monitoring)

`GET /api/health` — بيتحقق من الاتصال الفعلي بقاعدة البيانات (مش مجرد
"السيرفر شغال")، بيرجع `503` لو قاعدة البيانات مقطوعة. مربوط تلقائياً
كـ healthcheck في `railway.json` و`docker-compose.yml` و`Dockerfile`.

## التوثيق الكامل

| المستند | المحتوى |
|---|---|
| `docs/INSTALLATION.md` | تركيب محلي خطوة بخطوة |
| `docs/DEPLOYMENT_GUIDE.md` | Railway + Docker + VPS + checklist إنتاجي |
| `docs/DATABASE_SETUP.md` | إعداد Supabase/Postgres، ترتيب الـ migrations، الفهرسة |
| `docs/ENVIRONMENT_VARIABLES.md` | شرح كل متغير بيئة وتأثيره |
| `docs/ADMIN_GUIDE.md` | إدارة المستخدمين، مصفوفة الصلاحيات، سجل التدقيق |
| `docs/DEVELOPER_GUIDE.md` | البنية المعمارية، قواعد الـ locking/transactions، إضافة موديول جديد |
| `docs/API_DOCUMENTATION.md` | مرجع كل الـ API endpoints |
| `docs/TROUBLESHOOTING.md` | حلول لمشاكل شائعة فعلية (مبني على أعطال حقيقية اكتُشفت) |
| `docs/PWA_GUIDE.md` | تثبيت التطبيق على Windows/Android، التحديثات، مسح الكاش |
| `docs/USER_GUIDE_AR.md` | دليل استخدام يومي لكل الأدوار |
| `docs/RELEASE_NOTES.md` | سجل كامل بتغييرات Stage 5 |
| `deploy/BACKUP_GUIDE.md` | النسخ الاحتياطي والاستعادة |
| `.env.example` | نموذج متغيرات البيئة |

## أمان — تذكير مهم

لو سبق ورفعت ملف `.env` أو شاركته بأي شكل، اعتبر كل الأسرار اللي فيه
(`DATABASE_URL`, `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`) **مكشوفة** وابدّلها
فوراً من مصدرها (Supabase Dashboard، بوت تيليجرام BotFather).
