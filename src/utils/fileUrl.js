// utils/fileUrl.js
// دالة موحّدة لبناء رابط كامل لملف مرفوع (صورة منتج، إثبات دفع، إلخ) —
// بديل عن تكرار نفس المنطق (req.protocol + req.get('host')) في كل ملف
// راوت بيتعامل مع رفع ملفات.
function buildFileUrl(req, filePath) {
  if (!filePath) return null;
  if (filePath.startsWith('http')) return filePath;
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}${filePath}`;
}

module.exports = { buildFileUrl };
