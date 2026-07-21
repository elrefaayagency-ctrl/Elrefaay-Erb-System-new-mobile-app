# توثيق الـ API (API Documentation)

> ملحوظة: ده مرجع مختصر (endpoint + method) لكل موديول، مش OpenAPI/Swagger
> spec كامل بكل حقول الـ request/response. كل الـ endpoints دي مُستخرجة
> مباشرة من كود الـ routes الفعلي (مش موثّقة يدويًا بشكل منفصل عرضة
> للتضارب مع الكود الحقيقي).

كل الـ endpoints تحت `/api`، وكلها محتاجة `Authorization: Bearer <token>`
عدا `POST /api/auth/login`. احصل على التوكن من `/api/auth/login`.

| Base path | الوصف |
|---|---|
| `/api/auth` | `POST /login`, `GET /me` |
| `/api/users` | إدارة المستخدمين (admin فقط) — `GET/POST /`, `PUT/DELETE /:id`, `PUT /:id/locations` |
| `/api/products` | `GET /`, `GET /:id`, `GET /barcode/:barcode`, `POST /`, `PUT/DELETE /:id`, `DELETE /:id/image`, `GET /:id/movements`, `GET /print/barcode` |
| `/api/categories` | `GET/POST /`, `PUT/DELETE /:id` |
| `/api/locations` | `GET /`, `GET /all`, `GET /:id`, `POST /`, `PUT /:id`, `GET /:id/inventory` |
| `/api/inventory` | `GET /overview`, `GET /low-stock`, `POST /adjust`, `GET /movements` |
| `/api/transfers` | `GET /`, `POST /` (تحويل بين مخازن) |
| `/api/import` | `GET /template`, `POST /products` (استيراد Excel) |
| `/api/suppliers` | `GET/POST /`, `GET/PUT /:id`, `PUT /:id/relations`, `GET /:id/statement`, `POST /import`, `GET /import/template`, `DELETE /:id` |
| `/api/purchase-orders` | `GET/POST /`, `GET /:id`, `PUT /:id/status`, `PUT /:id` |
| `/api/purchase-receipts` | `GET/POST /`, `GET /:id` (استلام بضاعة) |
| `/api/supplier-payments` | `GET/POST /`, `DELETE /:id` |
| `/api/installments` | `GET /` (أقساط موردين), `GET /dashboard` |
| `/api/customers` | `GET/POST /`, `GET /geo/list`, `GET/PUT /:id`, `GET /:id/statement`, `POST /import`, `GET /import/template`, `DELETE /:id` |
| `/api/invoices` | `GET /`, `GET /summary`, `GET /by-number/:number`, `GET /:id`, `POST /`, `POST /:id/confirm`, `PUT /:id`, `POST /:id/cancel`, `PUT /:id/status`, `GET /:id/pdf`, `GET /:id/thermal`, `GET /:id/whatsapp` |
| `/api/customer-payments` | `GET/POST /`, `DELETE /:id` |
| `/api/customer-installments` | `GET /`, `GET /dashboard` |
| `/api/sales-returns` | `GET/POST /`, `GET /:id`, `POST /:id/approve`, `POST /:id/return-to-customer`, `PUT /:id/reject` |
| `/api/settings` | `GET/PUT /` |
| `/api/expenses` | `GET/POST /categories`, `PUT/DELETE /categories/:id`, `GET/POST /`, `GET/PUT/DELETE /:id` |
| `/api/commissions` | `GET/POST /rules`, `PUT/DELETE /rules/:id`, `GET /`, `GET /monthly-summary`, `POST /pay`, `PUT /:id/cancel` |
| `/api/reports` | `GET /sales`, `/profit`, `/inventory-valuation`, `/product-performance`, `/balances`, `/expenses-by-category`, `/dashboard-kpis`, `/collections` (admin/manager فقط) |
| `/api/health` | فحص صحة السيرفر (بدون توثيق مطلوب) |

## أمثلة أساسية

```bash
# تسجيل الدخول
curl -X POST /api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}'
# → { "token": "...", "user": {...} }

# استخدام التوكن
curl /api/products -H "Authorization: Bearer <token>"
```

## أكواد الأخطاء الشائعة

| الكود | المعنى |
|---|---|
| 400 | بيانات الطلب غير صحيحة (تفصيل الرسالة بالعربي في `error`) |
| 401 | توكن غير موجود/منتهي/غير صحيح |
| 403 | التوكن صحيح لكن الدور مالوش صلاحية لهذا الإجراء |
| 404 | السجل غير موجود |
| 429 | تجاوزت الحد المسموح من الطلبات (rate limiting) |
| 503 | (بس في `/api/health`) قاعدة البيانات غير متصلة |

## تطوير مستقبلي موصى به
لو الفريق كبر أو محتاج توثيق تفاعلي (Swagger UI)، الخطوة الطبيعية التالية
هي إضافة `swagger-jsdoc` + `swagger-ui-express` وتوليد الـ spec من
تعليقات JSDoc فوق كل route — مش جزء من هذا التسليم لتفادي إضافة
dependency وتعقيد غير مطلوبين حاليًا.
