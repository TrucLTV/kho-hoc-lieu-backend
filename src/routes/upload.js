const express  = require('express');
const authMw   = require('../middleware/auth');
const supabase = require('../db');
const router   = express.Router();

const BUCKET = 'khl-files'; // tên bucket trong Supabase Storage

/* ── POST /api/upload ── GV upload file lên Supabase Storage */
router.post('/', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới được upload' });

  try {
    // Đọc raw body đã được parse bởi express.raw middleware
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Cần gửi multipart/form-data' });
    }

    // Dùng busboy để parse multipart
    const busboy = require('busboy');
    const bb = busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

    let filePath = '';
    let fileBuffer = null;
    let fileMime  = 'application/octet-stream';
    let fileName  = '';

    bb.on('field', (name, val) => {
      if (name === 'path') filePath = val;
    });

    bb.on('file', (fieldname, file, info) => {
      const { filename, mimeType } = info;
      fileName = filename;
      fileMime = mimeType || 'application/octet-stream';
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('finish', async () => {
      if (!fileBuffer || !filePath) {
        return res.status(400).json({ error: 'Thiếu file hoặc path' });
      }

      // Upload lên Supabase Storage
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, fileBuffer, {
          contentType: fileMime,
          upsert: true
        });

      if (error) {
        console.error('Storage upload error:', error);
        return res.status(500).json({ error: error.message });
      }

      // Lấy public URL
      const { data: urlData } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(filePath);

      res.json({ url: urlData.publicUrl, path: filePath });
    });

    req.pipe(bb);

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Lỗi upload' });
  }
});

/* ── DELETE /api/upload ── Xóa file khỏi Storage */
router.delete('/', authMw, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Chỉ admin mới được xóa file' });

  const { path } = req.body;
  if (!path) return res.status(400).json({ error: 'Thiếu path' });

  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã xóa file' });
});

module.exports = router;
