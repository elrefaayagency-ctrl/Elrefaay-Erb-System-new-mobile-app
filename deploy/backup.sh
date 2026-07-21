#!/usr/bin/env bash
# deploy/backup.sh — نسخة احتياطية يومية: قاعدة البيانات + ملفات uploads
#
# الاستخدام (من جذر المشروع):
#   bash deploy/backup.sh
#
# الجدولة اليومية عبر crontab على VPS (مثال: كل يوم الساعة 3 صباحاً):
#   crontab -e
#   0 3 * * * cd /path/to/najaf-erp-backend && bash deploy/backup.sh >> logs/backup.log 2>&1
#
# ملحوظة مهمة لو الاستضافة على Railway: الملفات هنا بتتخزن جوه الكونتينر
# نفسه، وأي redeploy/restart بيمسح الـ filesystem المحلي بالكامل (ephemeral).
# فبالنسبة لـ Railway تحديداً، الاعتماد الأساسي لازم يكون على النسخ
# الاحتياطي التلقائي المدمج في Supabase (Point-in-Time Recovery في خطط
# Pro فما فوق) + رفع نسخة هذا السكريبت دورياً لتخزين خارجي (S3/Backblaze...)
# بدل ما تفضل جوه الكونتينر. هذا السكريبت مناسب 100% لو الاستضافة VPS
# (القرص فيه دائم ومش بيتمسح بين النشرات).

set -euo pipefail

# ─── تحميل متغيرات البيئة من .env ───
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  # ملحوظة: بعض المحررات (خصوصاً على Windows) بتحفظ .env بنهايات أسطر CRLF،
  # وده بيكسر `source` العادي (bash بيفسّر \r كجزء من الأمر). الحل: نمرر
  # نسخة منقّاة من \r عبر process substitution بدل ما نعمل source للملف مباشرة.
  source <(sed 's/\r$//' .env)
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "✗ خطأ: DATABASE_URL غير موجود. تأكد من وجود ملف .env صحيح." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
DB_BACKUP_FILE="$BACKUP_DIR/db_${TIMESTAMP}.sql.gz"
UPLOADS_BACKUP_FILE="$BACKUP_DIR/uploads_${TIMESTAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

# ─── دالة إشعار فشل عبر تيليجرام (بتستخدم نفس متغيرات .env الموجودة أصلاً) ───
notify_failure() {
  local message="$1"
  echo "✗ $message" >&2
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    # ملحوظة مهمة (إصلاح باج حقيقي): curl -d العادي بيبعت القيمة زي ما هي من
    # غير أي ترميز فعلي (percent-encoding)، فأي نص عربي أو إيموجي كان بيوصل
    # لتيليجرام مشوّه (علامات ?????). الحل: --data-urlencode بيرمّز الـ UTF-8
    # صح فعلياً قبل الإرسال. وكمان بنجبر locale الجلسة على UTF-8 صراحة، لأن
    # cron غالباً بيشغّل السكريبتات بأقل locale ممكن (POSIX/C) اللي ممكن
    # يكسر تمرير حروف عربية للأداة نفسها قبل ما توصل لـ curl خالص.
    LC_ALL=C.UTF-8 curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=🔴 فشل النسخ الاحتياطي لنظام نجف وإضاءة ERP على $(hostname): ${message}" \
      > /dev/null || true
  fi
}

trap 'notify_failure "خطأ غير متوقع أثناء تنفيذ سكريبت النسخ الاحتياطي (راجع logs/backup.log)"' ERR

# ─── 1) نسخة قاعدة البيانات (pg_dump + ضغط) ───
echo "→ جاري نسخ قاعدة البيانات..."
if ! command -v pg_dump &> /dev/null; then
  notify_failure "الأمر pg_dump غير مثبت على السيرفر. ثبّته بـ: apt install postgresql-client"
  exit 1
fi
pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip > "$DB_BACKUP_FILE"

if [ ! -s "$DB_BACKUP_FILE" ]; then
  notify_failure "ملف نسخة قاعدة البيانات فارغ أو لم يُنشأ — النسخ الاحتياطي فشل"
  exit 1
fi
echo "✓ نسخة قاعدة البيانات: $DB_BACKUP_FILE ($(du -h "$DB_BACKUP_FILE" | cut -f1))"

# ─── 2) نسخة ملفات uploads (صور المنتجات + إثباتات الدفع) ───
echo "→ جاري نسخ ملفات uploads..."
tar -czf "$UPLOADS_BACKUP_FILE" \
  --exclude='src/uploads/temp' \
  -C "$PROJECT_ROOT" src/uploads/products src/uploads/payment_proofs 2>/dev/null || true
echo "✓ نسخة الملفات: $UPLOADS_BACKUP_FILE ($(du -h "$UPLOADS_BACKUP_FILE" 2>/dev/null | cut -f1 || echo '0'))"

# ─── 3) تنظيف النسخ الأقدم من فترة الاحتفاظ ───
echo "→ حذف النسخ الأقدم من $RETENTION_DAYS يوم..."
find "$BACKUP_DIR" -name "db_*.sql.gz" -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name "uploads_*.tar.gz" -mtime "+$RETENTION_DAYS" -delete

echo "✓ اكتمل النسخ الاحتياطي بنجاح — $TIMESTAMP"
