# دليل النشر والإنتاج (Deployment & Production Guide)

هذا الملف بيغطي "دليل النشر" و"دليل الإنتاج" مع بعض عمداً — الفصل بينهم كان
هيبقى تكرار (كل قرار نشر هنا هو أصلاً قرار إنتاجي). لأي تفاصيل متغيرات
البيئة، شوف `docs/ENVIRONMENT_VARIABLES.md`. للنسخ الاحتياطي، شوف
`deploy/BACKUP_GUIDE.md`.

## 1. Railway (الأسهل للبدء)

1. اربط الـ repo بـ Railway (أو ارفعه مباشرة عبر Railway CLI)
2. من Dashboard → Variables، أضف كل المتغيرات من `.env.example` (خصوصاً
   `DATABASE_URL` و`JWT_SECRET`)
3. Railway بيكتشف `railway.json` تلقائياً ويستخدم إعداداته (healthcheck
   على `/api/health`، إعادة تشغيل تلقائية عند الفشل حتى 5 مرات)
4. Deploy — أول تشغيل بينشئ كل الجداول تلقائياً

**⚠️ قيد مهم:** الـ filesystem في Railway ephemeral (بيتمسح مع كل
redeploy). ملفات uploads (صور المنتجات) لازم تُخزَّن في تخزين خارجي دائم
لو محتاج ضمان بقائها عبر النشرات (S3-compatible storage) — ده قرار بنية
تحتية إضافي حسب حجم الاستخدام الفعلي، مش جزء افتراضي من هذا التسليم.

## 2. VPS عبر Docker (موصى به للتحكم الكامل)

```bash
cp .env.example .env   # واملأه
docker compose up -d --build
docker compose logs -f app        # تابع الإقلاع
curl http://localhost:5000/api/health
```

بعدين اربط Nginx (`deploy/nginx.conf`) على البورت 80/443 قدام الكونتينر،
وفعّل SSL بـ certbot (التعليمات في أعلى الملف نفسه).

## 3. VPS بدون Docker (PM2)

```bash
npm ci --omit=dev
cp .env.example .env   # واملأه
pm2 start deploy/ecosystem.config.js
pm2 save && pm2 startup   # يخلي PM2 يشتغل تلقائي بعد إعادة تشغيل السيرفر
```

عدّل `deploy/nginx.conf`: غيّر مسار `/uploads/` من `/app/src/uploads/`
للمسار الفعلي للمشروع على السيرفر (مثال: `/home/deploy/najaf-erp/src/uploads/`).

## 4. Checklist ما قبل أي نشر إنتاجي

- [ ] `JWT_SECRET` عشوائي 32+ حرف (السيرفر يرفض يشتغل من غيره)
- [ ] `NODE_ENV=production`
- [ ] `DATABASE_SSL=true` (إلا لو قاعدة البيانات محلية بدون SSL)
- [ ] كلمة مرور `admin` الافتراضية (`admin123`) اتغيّرت فوراً بعد أول دخول
- [ ] `ALLOWED_ORIGINS` محدد لو الفرونت اند على نطاق منفصل عن الـ API
- [ ] النسخ الاحتياطي مجدول (`deploy/BACKUP_GUIDE.md`)
- [ ] `server_name` في `deploy/nginx.conf` معدّل للنطاق الحقيقي
- [ ] اختبار فعلي لـ `GET /api/health` بعد النشر

## 5. المراقبة (Monitoring)

- `GET /api/health` — فحص حقيقي لاتصال قاعدة البيانات، بيرجع `503` لو
  مقطوعة. مربوط تلقائياً كـ healthcheck في Railway/Docker
- Logs بصيغة JSON منظّمة (`src/utils/logger.js`) — قابلة للفلترة في أي
  أداة تجميع logs (Railway Logs, أو `docker compose logs`, أو أي ELK/Datadog
  مستقبلاً بدون تعديل الكود)
- تكامل مع أدوات مراقبة أخطاء خارجية (Sentry مثلاً) لم يُضَف — النظام
  الحالي (logger + audit_log + Telegram alerts للنسخ الاحتياطي) كافٍ
  لحجم الفريق الحالي؛ لو الفريق كبر، إضافة Sentry مجرد `require` واحد
  في `server.js` بدون تغيير بنيوي

## 6. تحقق فعلي تم أثناء هذا التسليم

- `npm ci --omit=dev` (نفس أمر الـ Dockerfile بالضبط) — نجح
- تشغيل السيرفر فعلياً ضد قاعدة بيانات PostgreSQL حقيقية فاضية تمامًا —
  نجح بعد إصلاح ترتيب الـ migrations (شوف `docs/RELEASE_NOTES.md`)
- تشغيل UAT فعلي كامل عبر الـ API (مش مجرد قراءة كود) — كل سيناريوهات
  العمل الأساسية اتفحصت وتأكدت شغالة
- **لم يتم تنفيذه فعلياً:** `docker build` الحقيقي — بيئة إعداد هذا
  التسليم معندهاش Docker daemon. `Dockerfile` اتفحص بديل عبر تنفيذ نفس
  خطواته يدوياً (`npm ci --omit=dev` بنجاح)، لكن الـ build الكامل للصورة
  لازم يتنفذ ويتأكد منه على جهازك/سيرفرك قبل الاعتماد الكامل عليه في الإنتاج:
  ```bash
  docker build -t najaf-erp .
  docker run --rm -p 5000:5000 --env-file .env najaf-erp
  ```
