// middleware/auth.js
const jwt = require('jsonwebtoken');

// أمان: ممنوع أي fallback ثابت للمفتاح السري في الكود. لو الـ env var
// مش موجود، السيرفر يرفض يشتغل بدل ما يستخدم مفتاح معروف للعامة
// (لو حصل كده أي حد يقدر يزوّر tokens بأي صلاحية، حتى admin).
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET غير معرّف أو قصير جداً (لازم 32 حرف على الأقل). ' +
    'عرّفه في متغيرات البيئة قبل تشغيل السيرفر. السيرفر لن يعمل بمفتاح افتراضي لأسباب أمنية.'
  );
}

function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول للوصول لهذه الصفحة' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'الجلسة منتهية، يرجى تسجيل الدخول مرة أخرى' });
  }
}

// السماح فقط لأدوار محددة بالوصول للـ endpoint
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'ليس لديك صلاحية للقيام بهذا الإجراء' });
    }
    next();
  };
}

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      can_view_cost_price: !!user.can_view_cost_price,
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

module.exports = { authenticate, authorize, generateToken, JWT_SECRET };
