// utils/stockAlerts.js
// ─── مصدر الحقيقة الوحيد لمنطق "تنبيه المخزون المنخفض" في كل النظام ───
// قبل هذا الملف كان نفس المنطق (الكمية <= الحد) مكرر في مكانين مختلفين
// (products.js لقائمة المنتجات، وinventory.js لصفحة التنبيهات) بشكل منفصل،
// وكمان الواجهة كانت بتعمل حسبة تالتة مستقلة لعرض شريط تقدم كل مخزن.
// أي تعديل مستقبلي في منطق التنبيه (زي إضافة Mode B) كان محتاج يتكرر
// في 3 أماكن. دلوقتي كل حاجة بتمر من هنا.

const { all } = require('../db/database');

// يرجّع صفوف المخزون لمنتج معين عبر كل المخازن (المسموح بيها حسب الفلتر
// الممرّر)، بما فيها حد التنبيه الخاص بكل مخزن لو النمط per_location.
async function getProductStockRows(productId, locFilter = '', locParams = []) {
  return all(`
    SELECT l.id as location_id, l.name as location_name, l.type,
           COALESCE(i.quantity, 0) as quantity,
           plt.min_stock_threshold as location_threshold
    FROM locations l
    LEFT JOIN inventory i ON i.location_id = l.id AND i.product_id = ?
    LEFT JOIN product_location_thresholds plt ON plt.location_id = l.id AND plt.product_id = ?
    WHERE l.is_active = 1 ${locFilter}
    ORDER BY l.id
  `, [productId, productId, ...locParams]);
}

// منطق التقييم نفسه — نمط واحد بيتفرّع لسلوكين:
//
// Mode A ("global", الافتراضي — متوافق 100% مع كل منتج قديم): حد تنبيه واحد
//        يُقارن بإجمالي الكمية عبر كل المخازن مجتمعة.
// Mode B ("per_location"، اختياري): كل مخزن له حد تنبيه مستقل خاص بيه في
//        جدول product_location_thresholds؛ المخزن اللي معندوش حد محدد له
//        صراحة مايتنبّهش عنه أبداً (تجنباً لتنبيهات كاذبة على مخازن
//        المستخدم ماحددش لها حد أصلاً).
function evaluateLowStock(product, stockRows) {
  const totalQty = stockRows.reduce((s, r) => s + Number(r.quantity || 0), 0);

  if (product.low_stock_mode === 'per_location') {
    const lowLocations = stockRows.filter(r =>
      r.location_threshold !== null && r.location_threshold !== undefined &&
      Number(r.quantity || 0) <= Number(r.location_threshold)
    );
    return {
      mode: 'per_location',
      total_quantity: totalQty,
      is_low_stock: lowLocations.length > 0,
      low_locations: lowLocations.map(r => ({
        location_id: r.location_id, location_name: r.location_name,
        quantity: Number(r.quantity || 0), threshold: Number(r.location_threshold),
      })),
    };
  }

  const threshold = Number(product.min_stock_threshold) || 0;
  return {
    mode: 'global',
    total_quantity: totalQty,
    is_low_stock: totalQty <= threshold,
    low_locations: [],
  };
}

// يفحص كل المنتجات النشطة ويرجّع اللي فعلاً منخفضة المخزون — دالة واحدة
// مشتركة يستخدمها كل من راوت /inventory/low-stock والفحص الدوري للتنبيهات
// (src/jobs/notificationScheduler.js)، بدل تكرار نفس اللوب في المكانين.
async function getAllLowStockProducts(locFilter = '', locParams = []) {
  const products = await require('../db/database').all(`SELECT * FROM products WHERE is_active = 1`);
  const lowStockItems = [];

  for (const p of products) {
    const stockRows = await getProductStockRows(p.id, locFilter, locParams);
    const evaluation = evaluateLowStock(p, stockRows);

    if (evaluation.is_low_stock) {
      lowStockItems.push({
        product_id: p.id, sku: p.sku, name: p.name, unit: p.unit,
        image_path: p.image_path, min_stock_threshold: p.min_stock_threshold,
        low_stock_mode: p.low_stock_mode || 'global',
        total_quantity: evaluation.total_quantity,
        low_locations: evaluation.low_locations,
        stock_by_location: stockRows.map(r => ({ location_name: r.location_name, quantity: r.quantity })),
      });
    }
  }
  return lowStockItems;
}

module.exports = { getProductStockRows, evaluateLowStock, getAllLowStockProducts };
