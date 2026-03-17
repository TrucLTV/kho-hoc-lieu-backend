const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const supabase = require('../db');
const authMw   = require('../middleware/auth');
const router   = express.Router();

/* ── POST /api/auth/login ── */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Vui lòng nhập tài khoản và mật khẩu' });

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .single();

  if (error || !user)
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });

  if (!user.approved)
    return res.status(403).json({ error: 'Tài khoản chưa được giáo viên duyệt' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid)
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.full_name },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({ token, role: user.role, name: user.full_name, id: user.id });
});

/* ── POST /api/auth/register ── học sinh tự đăng ký */
router.post('/register', async (req, res) => {
  const { username, password, full_name } = req.body;
  if (!username || !password || !full_name)
    return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Mật khẩu tối thiểu 4 ký tự' });

  const hash = await bcrypt.hash(password, 10);
  const { error } = await supabase.from('users').insert([{
    username, password_hash: hash, full_name, role: 'student', approved: false
  }]);

  if (error) {
    if (error.code === '23505') // unique violation
      return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
    return res.status(500).json({ error: 'Lỗi server: ' + error.message });
  }

  res.json({ message: 'Đăng ký thành công! Chờ giáo viên duyệt tài khoản.' });
});

/* ── POST /api/auth/change-password ── đổi mật khẩu (admin & học sinh) */
router.post('/change-password', authMw, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password)
    return res.status(400).json({ error: 'Vui lòng nhập mật khẩu cũ và mật khẩu mới' });
  if (new_password.length < 4)
    return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 4 ký tự' });

  const { data: user } = await supabase
    .from('users').select('*').eq('id', req.user.id).single();

  const valid = await bcrypt.compare(old_password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Mật khẩu cũ không đúng' });

  const hash = await bcrypt.hash(new_password, 10);
  await supabase.from('users').update({ password_hash: hash }).eq('id', req.user.id);
  res.json({ message: 'Đổi mật khẩu thành công' });
});

module.exports = router;
