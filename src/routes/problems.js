// src/routes/problems.js
// Quản lý bài tập lập trình + testcase (giáo viên/admin)
const express  = require('express');
const supabase = require('../db');
const authMw   = require('../middleware/auth');
const router   = express.Router();

/* ─────────────────────────────────────────────────────────
   GET /api/problems?item_id=xxx
   Học sinh & admin đều xem được bài tập của một item
───────────────────────────────────────────────────────── */
router.get('/', authMw, async (req, res) => {
  const { item_id } = req.query;
  if (!item_id) return res.status(400).json({ error: 'Thiếu item_id' });

  const { data: problems, error } = await supabase
    .from('coding_problems')
    .select('id, title, description, input_format, output_format, constraints, example_input, example_output, time_limit_ms, memory_limit_mb, allowed_languages, created_at')
    .eq('item_id', item_id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // Đính kèm sample testcases (is_sample = true) để hiển thị cho học sinh
  for (const prob of problems) {
    const { data: samples } = await supabase
      .from('testcases')
      .select('id, input, expected, position')
      .eq('problem_id', prob.id)
      .eq('is_sample', true)
      .order('position');
    prob.sample_testcases = samples || [];
  }

  res.json(problems);
});

/* ─────────────────────────────────────────────────────────
   GET /api/problems/:id
   Lấy chi tiết 1 bài (admin còn thấy TẤT CẢ testcase)
───────────────────────────────────────────────────────── */
router.get('/:id', authMw, async (req, res) => {
  const { id } = req.params;

  const { data: prob, error } = await supabase
    .from('coding_problems')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

  // Admin xem được tất cả testcase; học sinh chỉ thấy sample
  const isAdmin = req.user.role === 'admin';
  let tcQuery = supabase
    .from('testcases')
    .select('id, input, expected, is_sample, score_weight, position')
    .eq('problem_id', id)
    .order('position');

  // Supabase query builder la immutable - phai gan lai bien
  if (!isAdmin) tcQuery = tcQuery.eq('is_sample', true);

  const { data: testcases, error: tcErr } = await tcQuery;
  if (tcErr) console.error('[problems] Loi tai testcase:', tcErr.message);
  prob.testcases = testcases || [];

  res.json(prob);
});

/* ─────────────────────────────────────────────────────────
   POST /api/problems
   Admin tạo bài tập mới
───────────────────────────────────────────────────────── */
router.post('/', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới tạo được bài tập' });

  const {
    item_id, title, description,
    input_format, output_format, constraints,
    example_input, example_output,
    time_limit_ms, memory_limit_mb, allowed_languages
  } = req.body;

  if (!item_id || !title || !description)
    return res.status(400).json({ error: 'Thiếu item_id, title hoặc description' });

  const { data, error } = await supabase
    .from('coding_problems')
    .insert([{
      item_id, title, description,
      input_format:   input_format   || '',
      output_format:  output_format  || '',
      constraints:    constraints    || '',
      example_input:  example_input  || '',
      example_output: example_output || '',
      time_limit_ms:   time_limit_ms   || 2000,
      memory_limit_mb: memory_limit_mb || 256,
      allowed_languages: allowed_languages || ['python','javascript'],
      created_by: req.user.id
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* ─────────────────────────────────────────────────────────
   PUT /api/problems/:id
   Admin cập nhật bài tập
───────────────────────────────────────────────────────── */
router.put('/:id', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới sửa được bài tập' });

  const { id } = req.params;
  const fields = [
    'title','description','input_format','output_format',
    'constraints','example_input','example_output',
    'time_limit_ms','memory_limit_mb','allowed_languages'
  ];
  const update = { updated_at: new Date().toISOString() };
  fields.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const { data, error } = await supabase
    .from('coding_problems').update(update).eq('id', id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* ─────────────────────────────────────────────────────────
   DELETE /api/problems/:id
   Admin xóa bài tập (cascade xóa testcases + submissions)
───────────────────────────────────────────────────────── */
router.delete('/:id', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới xóa được bài tập' });

  const { error } = await supabase
    .from('coding_problems').delete().eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã xóa bài tập' });
});

/* ─────────────────────────────────────────────────────────
   POST /api/problems/:id/testcases
   Admin thêm testcase
───────────────────────────────────────────────────────── */
router.post('/:id/testcases', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới thêm testcase' });

  const { input, expected, is_sample, score_weight, position } = req.body;
  if (input === undefined || expected === undefined)
    return res.status(400).json({ error: 'Thiếu input hoặc expected' });

  const { data, error } = await supabase
    .from('testcases')
    .insert([{
      problem_id:   req.params.id,
      input:        String(input),
      expected:     String(expected).trim(),
      is_sample:    is_sample    || false,
      score_weight: score_weight || 1,
      position:     position     || 0
    }])
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* ─────────────────────────────────────────────────────────
   PUT /api/problems/:id/testcases/:tcid
   Admin sửa testcase
───────────────────────────────────────────────────────── */
router.put('/:id/testcases/:tcid', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới sửa testcase' });

  const { input, expected, is_sample, score_weight, position } = req.body;
  const update = {};
  if (input        !== undefined) update.input        = String(input);
  if (expected     !== undefined) update.expected     = String(expected).trim();
  if (is_sample    !== undefined) update.is_sample    = is_sample;
  if (score_weight !== undefined) update.score_weight = score_weight;
  if (position     !== undefined) update.position     = position;

  const { data, error } = await supabase
    .from('testcases').update(update).eq('id', req.params.tcid).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* ─────────────────────────────────────────────────────────
   DELETE /api/problems/:id/testcases/:tcid
   Admin xóa testcase
───────────────────────────────────────────────────────── */
router.delete('/:id/testcases/:tcid', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới xóa testcase' });

  const { error } = await supabase
    .from('testcases').delete().eq('id', req.params.tcid);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã xóa testcase' });
});

/* ─────────────────────────────────────────────────────────
   POST /api/problems/:id/testcases/bulk
   Admin upload nhiều testcase cùng lúc (replace all)
───────────────────────────────────────────────────────── */
router.post('/:id/testcases/bulk', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới upload testcase' });

  const { testcases } = req.body; // array: [{input, expected, is_sample, score_weight}]
  if (!Array.isArray(testcases) || testcases.length === 0)
    return res.status(400).json({ error: 'Danh sách testcase rỗng' });

  // Xóa tất cả testcase cũ
  await supabase.from('testcases').delete().eq('problem_id', req.params.id);

  const rows = testcases.map((tc, i) => ({
    problem_id:   req.params.id,
    input:        String(tc.input || ''),
    expected:     String(tc.expected || '').trim(),
    is_sample:    tc.is_sample    || false,
    score_weight: tc.score_weight || 1,
    position:     i
  }));

  const { data, error } = await supabase.from('testcases').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ inserted: data.length, testcases: data });
});

module.exports = router;
