// src/routes/submissions.js
const express      = require('express');
const supabase     = require('../db');
const authMw       = require('../middleware/auth');
const vm           = require('vm');
const os           = require('os');
const path         = require('path');
const fs           = require('fs');
const { execFileSync } = require('child_process');

const router = express.Router();

// ─────────────────────────────────────────────────────────
// Hàm chấm 1 testcase
// ─────────────────────────────────────────────────────────
async function judgeOne(language, source_code, input, expected, timeLimitMs) {
  const startTime = Date.now();
  let actual_output = '';
  let error_detail  = '';

  try {
    if (language === 'javascript') {
      actual_output = runJsSandbox(source_code, input, timeLimitMs);
    } else if (language === 'python') {
      actual_output = await runPiston('python', '3.10.0', source_code, input);
    } else if (language === 'c') {
      actual_output = await runPiston('c', '10.2.0', source_code, input);
    } else if (language === 'cpp') {
      actual_output = await runPiston('cpp', '10.2.0', source_code, input);
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

// ── Piston API (C, C++, Python) ──
async function runPiston(language, version, code, input) {
  const response = await fetch('https://emkc.org/api/v2/piston/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      language,
      version,
      files: [{ content: code }],
      stdin: input || ''
    })
  });
  const data = await response.json();
  console.log('🔍 Piston response:', JSON.stringify(data));
  if (data.compile?.stderr) throw new Error(data.compile.stderr);
  if (data.run?.stderr) throw new Error(data.run.stderr);
  return data.run?.stdout || '';
}

// ── JavaScript sandbox ──
function runJsSandbox(code, input, timeoutMs) {
  const lines = input ? input.split('\n') : [];
  const outputs = [];

  const sandbox = {
    console: { log: (...args) => outputs.push(args.map(String).join(' ')) },
    require:   undefined,
    process:   undefined,
    global:    undefined,
    __dirname: undefined,
    __filename: undefined,
  };

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

// ─────────────────────────────────────────────────────────
// POST /api/submissions
// ─────────────────────────────────────────────────────────
router.post('/', authMw, async (req, res) => {
  console.log('📥 Nhận submission:', { problem_id: req.body.problem_id, language: req.body.language });
  const { problem_id, language, source_code } = req.body;

  if (!problem_id || !language || !source_code)
    return res.status(400).json({ error: 'Thiếu problem_id, language hoặc source_code' });

  const { data: problem, error: probErr } = await supabase
    .from('coding_problems').select('*').eq('id', problem_id).single();
  if (probErr) return res.status(404).json({ error: 'Không tìm thấy bài tập' });

  if (!problem.allowed_languages.includes(language))
    return res.status(400).json({ error: `Ngôn ngữ "${language}" không được phép cho bài này` });

  const { data: testcases } = await supabase
    .from('testcases').select('*').eq('problem_id', problem_id).order('position');

  if (!testcases || testcases.length === 0)
    return res.status(400).json({ error: 'Bài tập chưa có testcase, vui lòng liên hệ giáo viên' });

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

  if (results.length > 0) {
    await supabase.from('submission_results').insert(results);
  }

  const passedCount = results.filter(r => r.passed).length;
  const score       = totalWeight > 0 ? Math.round(passedWeight / totalWeight * 100) : 0;
  let status = 'wrong_answer';
  if (passedCount === testcases.length)        status = 'accepted';
  else if (passedCount > 0)                    status = 'partial';
  else if (results.some(r => r.error_detail))  status = 'error';

  const errorMsg = results.find(r => r.error_detail)?.error_detail || '';

  const { data: updated, error: upErr } = await supabase
    .from('code_submissions')
    .update({
      status, score,
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
      testcase_pos:  r.testcase_pos,
      passed:        r.passed,
      actual_output: r.actual_output,
      error_detail:  r.error_detail,
      exec_time_ms:  r.exec_time_ms,
      expected:      testcases[i]?.is_sample ? testcases[i].expected : null,
      is_sample:     testcases[i]?.is_sample || false
    }))
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/submissions/problem/:problem_id/ranking
// ─────────────────────────────────────────────────────────
router.get('/problem/:problem_id/ranking', authMw, async (req, res) => {
  const { data, error } = await supabase
    .from('code_submissions')
    .select('student_id, student_name, score, passed_tests, total_tests, language, submitted_at')
    .eq('problem_id', req.params.problem_id)
    .eq('status', 'accepted')
    .order('score', { ascending: false })
    .order('submitted_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

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
// ─────────────────────────────────────────────────────────
router.post('/simple', authMw, async (req, res) => {
  const { item_title, source_code, language } = req.body;
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
// GET /api/submissions
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
// ─────────────────────────────────────────────────────────
router.get('/:id', authMw, async (req, res) => {
  const { data: sub, error } = await supabase
    .from('code_submissions').select('*').eq('id', req.params.id).single();

  if (error) return res.status(404).json({ error: 'Không tìm thấy submission' });

  if (req.user.role !== 'admin' && sub.student_id !== req.user.id)
    return res.status(403).json({ error: 'Không có quyền xem submission này' });

  const { data: results } = await supabase
    .from('submission_results')
    .select('testcase_pos, passed, actual_output, error_detail, exec_time_ms, testcase_id')
    .eq('submission_id', req.params.id)
    .order('testcase_pos');

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
