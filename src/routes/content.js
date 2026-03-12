const express  = require('express');
const supabase = require('../db');
const authMw   = require('../middleware/auth');
const router   = express.Router();

/* ── GET /api/content ── lấy toàn bộ data (sections + items + files) */
router.get('/', authMw, async (req, res) => {
  const { data, error } = await supabase
    .from('sections')
    .select(`
      id, name, type, desc, open, position,
      items (
        id, title, desc, position,
        files ( id, name, type, data_url, is_iv, position )
      )
    `)
    .order('position', { ascending: true })
    .order('position', { ascending: true, foreignTable: 'items' })
    .order('position', { ascending: true, foreignTable: 'items.files' });

  if (error) return res.status(500).json({ error: error.message });

  // Format giống hệt frontend expects: { id, name, type, desc, open, items: [{id, title, desc, files:[], ivFiles:[]}] }
  const formatted = (data || []).map(sec => ({
    id:    sec.id,
    name:  sec.name,
    type:  sec.type || 'lesson',
    desc:  sec.desc || '',
    open:  sec.open !== false,
    items: (sec.items || []).map(item => ({
      id:      item.id,
      title:   item.title,
      desc:    item.desc || '',
      files:   (item.files || []).filter(f => !f.is_iv).map(f => ({
        id: f.id, name: f.name, type: f.type, dataUrl: f.data_url
      })),
      ivFiles: (item.files || []).filter(f => f.is_iv).map(f => ({
        id: f.id, name: f.name, type: 'iv', dataUrl: f.data_url, isIV: true
      }))
    }))
  }));

  res.json(formatted);
});

/* ── POST /api/content ── lưu toàn bộ data (admin save) */
router.post('/', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới có quyền lưu nội dung' });

  const sections = req.body; // array of section objects
  if (!Array.isArray(sections))
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });

  // Upsert sections
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    const { error: secErr } = await supabase.from('sections').upsert({
      id: sec.id, name: sec.name, type: sec.type || 'lesson',
      desc: sec.desc || '', open: sec.open !== false, position: si
    });
    if (secErr) return res.status(500).json({ error: secErr.message });

    for (let ii = 0; ii < (sec.items || []).length; ii++) {
      const item = sec.items[ii];
      const { error: itemErr } = await supabase.from('items').upsert({
        id: item.id, section_id: sec.id,
        title: item.title, desc: item.desc || '', position: ii
      });
      if (itemErr) return res.status(500).json({ error: itemErr.message });

      // Save all files
      const allFiles = [
        ...(item.files   || []).map(f => ({ ...f, is_iv: false })),
        ...(item.ivFiles || []).map(f => ({ ...f, is_iv: true }))
      ];
      for (let fi = 0; fi < allFiles.length; fi++) {
        const f = allFiles[fi];
        const { error: fErr } = await supabase.from('files').upsert({
          id: f.id, item_id: item.id, name: f.name,
          type: f.type, data_url: f.dataUrl, is_iv: f.is_iv, position: fi
        });
        if (fErr) return res.status(500).json({ error: fErr.message });
      }

      // Xóa files không còn tồn tại
      const keepIds = allFiles.map(f => f.id);
      if (keepIds.length > 0) {
        await supabase.from('files')
          .delete().eq('item_id', item.id).not('id', 'in', `(${keepIds.join(',')})`);
      } else {
        await supabase.from('files').delete().eq('item_id', item.id);
      }
    }

    // Xóa items không còn tồn tại
    const keepItemIds = (sec.items || []).map(i => i.id);
    if (keepItemIds.length > 0) {
      await supabase.from('items')
        .delete().eq('section_id', sec.id).not('id', 'in', `(${keepItemIds.join(',')})`);
    } else {
      await supabase.from('items').delete().eq('section_id', sec.id);
    }
  }

  // Xóa sections không còn tồn tại
  const keepSecIds = sections.map(s => s.id);
  if (keepSecIds.length > 0) {
    await supabase.from('sections').delete().not('id', 'in', `(${keepSecIds.join(',')})`);
  } else {
    await supabase.from('sections').delete().neq('id', '');
  }

  res.json({ message: 'Đã lưu nội dung' });
});

module.exports = router;
