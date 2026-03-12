const express  = require('express');
const supabase = require('../db');
const authMw   = require('../middleware/auth');
const router   = express.Router();

/* ── POST /api/scores ── học sinh gửi điểm */
router.post('/', authMw, async (req, res) => {
  const { lesson_id, lesson_title, score, correct, total } = req.body;
  const student_id   = req.user.id;
  const student_name = req.user.name;
  const pct = total > 0 ? Math.round(correct / total * 100) : 0;

  // Đếm số lần làm bài trước đó
  const { count } = await supabase
    .from('scores')
    .select('*', { count: 'exact', head: true })
    .eq('student_id', student_id)
    .eq('lesson_id', lesson_id);

  const record = {
    student_id, student_name,
    lesson_id:    lesson_id    || null,
    lesson_title: lesson_title || 'Bài học',
    score:   score   || 0,
    correct: correct || 0,
    total:   total   || 5,
    pct,
    retry_count: (count || 0) + 1
  };

  // Thử lưu với lesson_id trước
  let { data, error } = await supabase.from('scores').insert([record]).select().single();

  // Nếu lỗi foreign key (lesson_id không tồn tại trong bảng items) → retry với null
  if (error && (error.code === '23503' || (error.message && error.message.includes('foreign key')))) {
    console.warn('[scores] lesson_id foreign key error, retrying with null:', lesson_id);
    const retry = await supabase.from('scores')
      .insert([{ ...record, lesson_id: null }])
      .select().single();
    data  = retry.data;
    error = retry.error;
  }

  if (error) {
    console.error('[scores] insert error:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

/* ── GET /api/scores ── admin xem tất cả điểm */
router.get('/', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới xem được bảng điểm' });

  const { data, error } = await supabase
    .from('scores')
    .select('*')
    .order('submitted_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
