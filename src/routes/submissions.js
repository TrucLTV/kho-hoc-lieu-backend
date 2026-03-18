// src/routes/submissions.js
// Nộp bài & chấm điểm server-side (JavaScript sandbox qua vm2/vm, Python qua child_process)
const express      = require('express');
const supabase     = require('../db');
const authMw       = require('../middleware/auth');
const { execSync, execFileSync } = require('child_process');
const vm           = require('vm');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { exec } = require('child_process');

exec('g++ --version', (err, stdout, stderr) => {
  console.log('g++ check:', stdout || stderr || err?.message);
});
const router       = express.Router();

// ─────────────────────────────────────────────────────────
// Hàm chấm 1 testcase với ngôn ngữ cụ thể
// Trả về { passed, actual_output, error_detail, exec_time_ms }
// ─────────────────────────────────────────────────────────
async function judgeOne(language, source_code, input, expected, timeLimitMs) {
  const startTime = Date.now();
  let actual_output = '';
  let error_detail  = '';

  try {
    if (language === 'javascript') {
      // ── JavaScript: chạy trong vm sandbox Node.js ──
      actual_output = runJsSandbox(source_code, input, timeLimitMs);

    } else if (language === 'python') {
      // ── Python: chạy qua child_process ──
      actual_output = runExternalProcess('python3', source_code, input, timeLimitMs, '.py');

    } else if (language === 'c') {
      actual_output = runCompiledC(source_code, input, timeLimitMs);

    } else if (language === 'cpp') {
      actual_output = runCompiledCpp(source_code, input, timeLimitMs);

    } else {
      return { passed: false, actual_output: '', error_detail: `Ngôn ngữ "${language}" chưa được hỗ trợ`, exec_time_ms: 0 };
    }
  } catch (err) {
    error_detail = err.message || String(err);
    actual_output = '';
  }

  const exec_time_ms = Date.now() - startTime;
  const passed = actual_output.trim() === String(expected).trim();
  return { passed, actual_output: actual_output.trim(), error_detail, exec_time_ms };
}

// ── JavaScript sandbox ──
function runJsSandbox(code, input, timeoutMs) {
  const lines = input.split('\n');
  let lineIdx = 0;
  const outputs = [];

  const sandbox = {
    console: { log: (...args) => outputs.push(args.map(String).join(' ')) },
    readline: () => lines[lineIdx++] || '',
    // Chặn hoàn toàn require, process, global để tránh sandbox escape
    require:   undefined,
    process:   undefined,
    global:    undefined,
    __dirname: undefined,
    __filename: undefined,
  };

  // Wrap code để bắt stdin-like readline
  const wrapped = `
(function(){
  const __lines = ${JSON.stringify(lines)};
  let __idx = 0;
  const readline = () => __lines[__idx++] || '';
  ${code}
})();`;

  const script = new vm.Script(wrapped, { filename: 'submission.js' });
  const ctx    = vm.createContext(sandbox);
  script.runInContext(ctx, { timeout: timeoutMs || 2000 });
  return outputs.join('\n');
}

// ── Chạy Python / ngôn ngữ script qua file tạm ──
function runExternalProcess(interpreter, code, input, timeoutMs, ext) {
  const tmpDir  = os.tmpdir();
  const srcFile = path.join(tmpDir, `sub_${Date.now()}${ext}`);
  fs.writeFileSync(srcFile, code, 'utf8');
  try {
    const output = execFileSync(interpreter, [srcFile], {
      input:   input,
      timeout: timeoutMs || 2000,
      maxBuffer: 1024 * 256,
      encoding: 'utf8',
      stdio: ['pipe','pipe','pipe']
    });
    return output;
  } finally {
    try { fs.unlinkSync(srcFile); } catch(_) {}
  }
}

// ── Compile + chạy C ──
function runCompiledC(code, input, timeoutMs) {
  const tmpDir  = os.tmpdir();
  const id      = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const srcFile = path.join(tmpDir, `sub_${id}.c`);
  const binFile = path.join(tmpDir, `sub_${id}.out`);
  fs.writeFileSync(srcFile, code, 'utf8');
  try {
    execSync(`gcc -O2 -o "${binFile}" "${srcFile}" 2>&1`, { timeout: 10000 });
    const output = execFileSync(binFile, [], {
      input, timeout: timeoutMs || 2000,
      maxBuffer: 1024 * 256, encoding: 'utf8'
    });
    return output;
  } finally {
    try { fs.unlinkSync(srcFile); } catch(_) {}
    try { fs.unlinkSync(binFile); } catch(_) {}
  }
}

// ── Compile + chạy C++ ──
function runCompiledCpp(code, input, timeoutMs) {
  const tmpDir  = os.tmpdir();
  const id      = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const srcFile = path.join(tmpDir, `sub_${id}.cpp`);
  const binFile = path.join(tmpDir, `sub_${id}.out`);
  fs.writeFileSync(srcFile, code, 'utf8');
  try {
    execSync(`g++ -O2 -std=c++17 -o "${binFile}" "${srcFile}" 2>&1`, { timeout: 10000 });
    const output = execFileSync(binFile, [], {
      input, timeout: timeoutMs || 2000,
      maxBuffer: 1024 * 256, encoding: 'utf8'
    });
    return output;
  } finally {
    try { fs.unlinkSync(srcFile); } catch(_) {}
    try { fs.unlinkSync(binFile); } catch(_) {}
  }
}

// ─────────────────────────────────────────────────────────
// POST /api/submissions
// Học sinh nộp bài – chấm ngay (sync)
// ─────────────────────────────────────────────────────────
router.post('/', authMw, async (req, res) => {
  console.log('📥 Nhận submission:', { problem_id: req.body.problem_id, language: req.body.language });
  const { problem_id, language, source_code } = req.body;

  if (!problem_id || !language || !source_code)
    return res.status(400).json({ error: 'Thiếu problem_id, language hoặc source_code' });

  // Lấy bài tập + tất cả testcase
  const { data: problem, error: probErr } = await supabase
    .from('coding_problems').select('*').eq('id', problem_id).single();
  if (probErr) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

  if (!problem.allowed_languages.includes(language))
    return res.status(400).json({ error: `Ngôn ngữ "${language}" không được phép cho bài này` });

  const { data: testcases } = await supabase
    .from('testcases').select('*').eq('problem_id', problem_id).order('position');

  if (!testcases || testcases.length === 0)
    return res.status(400).json({ error: 'Bài tập chưa có testcase, vui lòng liên hệ giáo viên' });

  // Tạo record submission với status = judging
  const { data: submission, error: subErr } = await supabase
    .from('code_submissions')
    .insert([{
      problem_id,
      student_id:   req.user.id,
      student_name: req.user.name,
      language,
      source_code,
      status:      'judging',
      total_tests: testcases.length
    }])
    .select().single();

  if (subErr) return res.status(500).json({ error: subErr.message });

  // ── Chấm từng testcase ──
  const results = [];
  let totalWeight = 0;
  let passedWeight = 0;

  for (const tc of testcases) {
    totalWeight += (tc.score_weight || 1);
    const result = await judgeOne(language, source_code, tc.input, tc.expected, problem.time_limit_ms);
    if (result.passed) passedWeight += (tc.score_weight || 1);

    results.push({
      submission_id: submission.id,
      testcase_id:   tc.id,
      testcase_pos:  tc.position,
      passed:        result.passed,
      actual_output: result.actual_output,
      error_detail:  result.error_detail,
      exec_time_ms:  result.exec_time_ms
    });
  }

  // Lưu kết quả từng testcase
  if (results.length > 0) {
    await supabase.from('submission_results').insert(results);
  }

  // Tính điểm & status
  const passedCount = results.filter(r => r.passed).length;
  const score       = totalWeight > 0 ? Math.round(passedWeight / totalWeight * 100) : 0;
  let status = 'wrong_answer';
  if (passedCount === testcases.length)   status = 'accepted';
  else if (passedCount > 0)              status = 'partial';
  else if (results.some(r => r.error_detail)) status = 'error';

  const errorMsg = results.find(r => r.error_detail)?.error_detail || '';

  // Cập nhật submission
  const { data: updated, error: upErr } = await supabase
    .from('code_submissions')
    .update({
      status,
      score,
      passed_tests: passedCount,
      total_tests:  testcases.length,
      error_msg:    errorMsg,
      judged_at:    new Date().toISOString()
    })
    .eq('id', submission.id)
    .select().single();

  if (upErr) return res.status(500).json({ error: upErr.message });

  res.json({
    ...updated,
    results: results.map((r, i) => ({
      testcase_pos: r.testcase_pos,
      passed:       r.passed,
      actual_output: r.actual_output,
      error_detail:  r.error_detail,
      exec_time_ms:  r.exec_time_ms,
      // Ẩn expected output của hidden tests với học sinh
      expected: testcases[i]?.is_sample ? testcases[i].expected : null,
      is_sample: testcases[i]?.is_sample || false
    }))
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/submissions/problem/:problem_id/ranking
// Bảng xếp hạng theo bài (admin + học sinh đều xem)
// ⚠️ Phải đặt TRƯỚC route /:id để tránh conflict
// ─────────────────────────────────────────────────────────
router.get('/problem/:problem_id/ranking', authMw, async (req, res) => {
  // Lấy submission tốt nhất của mỗi học sinh
  const { data, error } = await supabase
    .from('code_submissions')
    .select('student_id, student_name, score, passed_tests, total_tests, language, submitted_at')
    .eq('problem_id', req.params.problem_id)
    .eq('status', 'accepted')
    .order('score', { ascending: false })
    .order('submitted_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // Deduplicate: chỉ giữ lần tốt nhất của mỗi học sinh
  const seen = new Set();
  const ranking = (data || []).filter(s => {
    if (seen.has(s.student_id)) return false;
    seen.add(s.student_id);
    return true;
  });

  res.json(ranking);
});

// ─────────────────────────────────────────────────────────
// POST /api/submissions/simple
// Học sinh nộp bài đơn giản (không có judge/testcase)
// ⚠️ Phải đặt TRƯỚC route /:id để tránh conflict
// ─────────────────────────────────────────────────────────
router.post('/simple', authMw, async (req, res) => {
  const { item_id, item_title, source_code, language } = req.body;
  if (!source_code)
    return res.status(400).json({ error: 'Thiếu source_code' });

  const { data, error } = await supabase
    .from('code_submissions')
    .insert([{
      problem_id:   null,
      student_id:   req.user.id,
      student_name: req.user.name,
      language:     language || 'unknown',
      source_code,
      status:       'pending',
      score:        0,
      passed_tests: 0,
      total_tests:  0,
      error_msg:    item_title ? `Bài: ${item_title}` : '',
      judged_at:    null
    }])
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, id: data.id });
});

// ─────────────────────────────────────────────────────────
// GET /api/submissions/simple
// Admin xem tất cả bài nộp đơn giản từ học sinh
// ⚠️ Phải đặt TRƯỚC route /:id để tránh conflict
// ─────────────────────────────────────────────────────────
router.get('/simple', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới xem được' });

  const { data, error } = await supabase
    .from('code_submissions')
    .select('id, student_name, language, source_code, error_msg, submitted_at, status')
    .eq('status', 'pending')
    .order('submitted_at', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: error.message });

  const mapped = (data || []).map(s => ({
    ...s,
    item_title: s.error_msg ? s.error_msg.replace(/^Bài: /, '') : '—'
  }));

  res.json(mapped);
});

// ─────────────────────────────────────────────────────────
// GET /api/submissions?problem_id=xxx
// Học sinh xem lịch sử nộp của mình
// ─────────────────────────────────────────────────────────
router.get('/', authMw, async (req, res) => {
  const { problem_id } = req.query;
  const isAdmin = req.user.role === 'admin';

  let query = supabase
    .from('code_submissions')
    .select('id, problem_id, student_id, student_name, language, status, score, passed_tests, total_tests, error_msg, submitted_at, judged_at')
    .order('submitted_at', { ascending: false });

  if (problem_id) query = query.eq('problem_id', problem_id);
  if (!isAdmin)   query = query.eq('student_id', req.user.id);

  const { data, error } = await query.limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────────────────────
// GET /api/submissions/:id
// Xem chi tiết 1 submission (học sinh chỉ xem của mình)
// ─────────────────────────────────────────────────────────
router.get('/:id', authMw, async (req, res) => {
  const { data: sub, error } = await supabase
    .from('code_submissions').select('*').eq('id', req.params.id).single();

  if (error) return res.status(404).json({ error: 'Không tìm thấy submission' });

  // Học sinh chỉ được xem bài của mình
  if (req.user.role !== 'admin' && sub.student_id !== req.user.id)
    return res.status(403).json({ error: 'Không có quyền xem submission này' });

  // Lấy kết quả từng testcase
  const { data: results } = await supabase
    .from('submission_results')
    .select('testcase_pos, passed, actual_output, error_detail, exec_time_ms, testcase_id')
    .eq('submission_id', req.params.id)
    .order('testcase_pos');

  // Với học sinh: ẩn expected output của hidden tests
  if (req.user.role !== 'admin' && results) {
    const { data: testcases } = await supabase
      .from('testcases')
      .select('id, expected, is_sample')
      .in('id', results.map(r => r.testcase_id).filter(Boolean));

    const tcMap = {};
    (testcases || []).forEach(tc => { tcMap[tc.id] = tc; });

    results.forEach(r => {
      const tc = tcMap[r.testcase_id];
      r.expected  = tc?.is_sample ? tc.expected : null;
      r.is_sample = tc?.is_sample || false;
      delete r.testcase_id;
    });
  }

  res.json({ ...sub, results: results || [] });
});

module.exports = router;
