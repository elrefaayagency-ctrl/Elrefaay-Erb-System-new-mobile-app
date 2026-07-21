// ecosystem.config.js — بديل PM2 لـ Docker على VPS (لو مفضّل عدم استخدام
// كونتينرات). شغّله من جذر المشروع بـ: pm2 start deploy/ecosystem.config.js
//
// ملحوظة: لو بتستخدم هذا الملف (مش Docker)، مسار الـ uploads في nginx.conf
// (deploy/nginx.conf) لازم يتغيّر من /app/src/uploads/ للمسار الفعلي
// للمشروع على السيرفر، مثال: /home/deploy/najaf-erp/src/uploads/

module.exports = {
  apps: [
    {
      name: 'najaf-erp',
      script: './server.js',
      cwd: __dirname + '/..',
      instances: 1, // زوّدها لـ 'max' لو محتاج cluster mode (استفد من كل الأنوية) — آمن هنا لأن الحالة كلها في قاعدة البيانات، مفيش state محلي في الذاكرة
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '400M',
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '30s',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
