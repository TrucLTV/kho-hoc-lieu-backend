const express  = require('express');
const bcrypt   = require('bcryptjs');
const supabase = require('../db');
const authMw   = require('../middleware/auth');
const router   = express.Router();

/* Tất cả /api/users đều cần đăng nhập + là admin */
router.use(authMw, (req, res, next) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới có quyền này' });
  next();
});

/* ── GET /api/users ── danh sách học sinh */
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, full_name, role, approved, created_at')
    .eq('role', 'student')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* ── PATCH /api/users/:id/approve ── duyệt tài khoản */
router.patch('/:id/approve', async (req, res) => {
  const { error } = await supabase
    .from('users').update({ approved: true }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã duyệt tài khoản' });
});

/* ── DELETE /api/users/:id ── xóa học sinh */
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('users').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã xóa học sinh' });
});

/* ── POST /api/users ── admin thêm học sinh thủ công */
router.post('/', async (req, res) => {
  const { username, password, full_name } = req.body;
  if (!username || !password || !full_name)
    return res.status(400).json({ error: 'Thiếu thông tin' });

  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users').insert([{
    username, password_hash: hash, full_name, role: 'student', approved: true
  }]).select('id, username, full_name, approved').single();

  if (error) {
    if (error.code === '23505')
      return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

module.exports = router;
