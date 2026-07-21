# ─── Dockerfile إنتاجي — نظام نجف وإضاءة ERP ───
# مفيش خطوة build للفرونت اند هنا لأن public/ فيها الملفات الجاهزة بالفعل
# (Vite build سابق + index.html الرئيسي). لو الفرونت اند اتعدّل مستقبلاً
# ومحتاج rebuild، ضيف مرحلة build منفصلة قبل هذه المرحلة.

FROM node:20-alpine

# dumb-init: بيتعامل صح مع إشارات SIGTERM/SIGINT جوه الكونتينر (Docker/K8s
# graceful shutdown) — من غيره Node ممكن ميستقبلش إشارة الإيقاف صح كـ PID 1
RUN apk add --no-cache dumb-init

WORKDIR /app

# نسخ ملفات الـ dependencies الأول لوحدها عشان الاستفادة من Docker layer
# caching — أي تعديل في الكود من غير تعديل package.json مش هيعيد npm install
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# نسخ باقي المشروع
COPY . .

# مستخدم غير root للأمان (best practice — الكونتينر لا يعمل بصلاحيات root)
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 \
    && mkdir -p src/uploads/products src/uploads/payment_proofs src/uploads/temp \
    && chown -R nodejs:nodejs /app
USER nodejs

ENV NODE_ENV=production
EXPOSE 5000

# فحص صحة الكونتينر نفسه (منفصل عن healthcheck منصة الاستضافة، مفيد مع
# docker-compose أو أي orchestrator بيعتمد على docker's own HEALTHCHECK)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT||5000) + '/api/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
