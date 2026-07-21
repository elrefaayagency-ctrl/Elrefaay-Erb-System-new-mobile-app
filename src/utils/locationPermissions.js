// utils/locationPermissions.js
// دالة مركزية: ترجع مصفوفة IDs المواقع المسموح للمستخدم برؤيتها
// admin دائماً يرى كل المواقع
// غيره: يرى فقط ما حدده له الـ admin في user_location_permissions
// لو مفيش صفوف محددة للمستخدم → يرى كل المواقع (fallback للحسابات القديمة)
const { all } = require('../db/database');

async function getAllowedLocationIds(user) {
  if (user.role === 'admin') return null; // null = بدون فلتر (كل المواقع)

  const rows = await all(
    `SELECT location_id FROM user_location_permissions WHERE user_id = ?`,
    [user.id]
  );

  if (rows.length === 0) return null; // لا قيود محددة بعد → كل المواقع

  return rows.map(r => r.location_id);
}

// بناء جملة SQL للفلترة: ترجع string جاهزة للإضافة في WHERE
// مثال: "AND l.id IN (1,2,5)"  أو  ""  لو admin
function buildLocationFilter(allowedIds, alias = 'l') {
  if (!allowedIds) return ''; // admin أو بدون قيود
  if (allowedIds.length === 0) return ` AND 1=0`; // مش مفروض يحصل، لكن احتياطي
  return ` AND ${alias}.id IN (${allowedIds.join(',')})`;
}

module.exports = { getAllowedLocationIds, buildLocationFilter };
