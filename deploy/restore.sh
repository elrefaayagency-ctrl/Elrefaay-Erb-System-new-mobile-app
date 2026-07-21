#!/usr/bin/env bash
# deploy/restore.sh — استعادة قاعدة البيانات وملفات uploads من نسخة احتياطية
#
# ⚠️ تحذير: هذه العملية بتستبدل بيانات قاعدة البيانات الحالية بالكامل.
# استخدمها فقط في حالة كارثة فعلية (فقدان بيانات) أو نقل لسيرفر جديد.
#
# الاستخدام:
#   bash deploy/restore.sh backups/db_2026-07-15_03-00-00.sql.gz [backups/uploads_2026-07-15_03-00-00.tar.gz]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

DB_BACKUP_FILE="${1:-}"
UPLOADS_BACKUP_FILE="${2:-}"

if [ -z "$DB_BACKUP_FILE" ] || [ ! -f "$DB_BACKUP_FILE" ]; then
  echo "الاستخدام: bash deploy/restore.sh <مسار نسخة قاعدة البيانات .sql.gz> [مسار نسخة uploads .tar.gz]"
  echo "الملفات المتاحة في backups/:"
  ls -1 "$PROJECT_ROOT/backups/" 2>/dev/null | grep "^db_" || echo "  (لا توجد نسخ محلية)"
  exit 1
fi

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source <(sed 's/\r$//' .env)
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "✗ خطأ: DATABASE_URL غير موجود." >&2
  exit 1
fi

echo "═══════════════════════════════════════════════════"
echo "  ⚠️  تحذير: على وشك استبدال كل بيانات قاعدة البيانات"
echo "  الحالية بمحتوى: $DB_BACKUP_FILE"
echo "  قاعدة البيانات المستهدفة: $(echo "$DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]+(@)#\1***\2#')"
echo "═══════════════════════════════════════════════════"
read -r -p "اكتب 'yes' بالظبط للمتابعة: " confirm
if [ "$confirm" != "yes" ]; then
  echo "تم الإلغاء."
  exit 0
fi

echo "→ جاري استعادة قاعدة البيانات..."
gunzip -c "$DB_BACKUP_FILE" | psql "$DATABASE_URL"
echo "✓ تمت استعادة قاعدة البيانات"

if [ -n "$UPLOADS_BACKUP_FILE" ] && [ -f "$UPLOADS_BACKUP_FILE" ]; then
  echo "→ جاري استعادة ملفات uploads..."
  tar -xzf "$UPLOADS_BACKUP_FILE" -C "$PROJECT_ROOT"
  echo "✓ تمت استعادة ملفات uploads"
fi

echo "✓ اكتملت الاستعادة. أعد تشغيل السيرفر (pm2 restart najaf-erp أو docker compose restart)."
