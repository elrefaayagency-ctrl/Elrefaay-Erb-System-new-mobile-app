// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { get } = require('../db/database');
const { generateToken, authenticate } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { asyncHandler } = require('../utils/asyncHandler');

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
  }

  const user = await get(`SELECT * FROM users WHERE username = ?`, [username]);

  if (!user) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: 'هذا الحساب معطّل، يرجى التواصل مع مدير النظام' });
  }

  const passwordMatches = bcrypt.compareSync(password, user.password_hash);
  if (!passwordMatches) {
    // أمان: تسجيل محاولات الدخول الفاشلة (لحساب موجود) في سجل التدقيق
    // لإتاحة رصد محاولات brute-force أو اختراق حسابات لاحقاً
    await logAction(user.id, 'login_failed', 'user', user.id, null);
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const token = generateToken(user);
  await logAction(user.id, 'login', 'user', user.id, null);

  res.json({
    token,
    user: {
      id: user.id,
      full_name: user.full_name,
      username: user.username,
      role: user.role,
      can_view_cost_price: !!user.can_view_cost_price,
    },
  });
}));

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
