# دليل التركيب (Installation Guide)

## المتطلبات
- Node.js ≥ 20.0.0 (`node -v` للتأكد)
- حساب Supabase (أو أي PostgreSQL ≥ 13) — للحصول على `DATABASE_URL`
- Git (اختياري لكن موصى به)

## خطوات التركيب المحلي

```bash
git clone <repo-url> najaf-erp-backend   # أو فك ضغط الملف المسلَّم
cd najaf-erp-backend
npm install
cp .env.example .env
```

افتح `.env` واملأ على الأقل:
```
DATABASE_URL=<connection string من Supabase Dashboard → Database → Connection string>
JWT_SECRET=<ولّده بـ: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
```

```bash
npm run dev
```

أول تشغيل بينشئ كل الجداول تلقائياً (schema + كل الـ migrations بترتيب صحيح
ومُتحقَّق منه)، وبيزرع بيانات افتراضية:
- مستخدم admin: `admin` / `admin123` — **لازم تغيّر الباسورد فوراً بعد أول دخول**
- 4 مستودعات + صالة عرض
- تصنيفات منتجات افتراضية (نجف كريستال، نجف ديكوري، سبوت لايت...)

افتح `http://localhost:5000` في المتصفح.

## التحقق من نجاح التركيب

```bash
curl http://localhost:5000/api/health
# المتوقع: {"status":"ok","database":"connected",...}
```

لو رجع `503` أو خطأ اتصال، راجع `docs/TROUBLESHOOTING.md` قسم "فشل الاتصال بقاعدة البيانات".

## الخطوة التالية
- للنشر الفعلي (Railway/VPS): `docs/DEPLOYMENT_GUIDE.md`
- لفهم هيكل المشروع وبنيته الداخلية: `docs/DEVELOPER_GUIDE.md`
- لدليل الاستخدام اليومي: `docs/USER_GUIDE_AR.md`
