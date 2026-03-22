require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const app     = express();

/* ── CORS: cho phép frontend gọi API ── */
app.use(cors({
  origin: function(origin, cb) {
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:3000',
      'http://localhost:3001',
    ].filter(Boolean);

    // Cho phép không có origin (Postman, curl, same-origin)
    if (!origin) return cb(null, true);

    // Cho phép các URL đã cấu hình
    if (allowed.some(u => origin.startsWith(u.replace(/\/$/, ''))))
      return cb(null, true);

    // Cho phép GitHub Pages
    if (origin.endsWith('.github.io'))
      return cb(null, true);

    // Cho phép toàn bộ IP local (192.168.x.x, 10.x.x.x, 172.x.x.x)
    if (/^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin))
      return cb(null, true);

    cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

/* ── Serve Frontend (các file HTML/CSS/JS) ── */
app.use(express.static(path.join(__dirname, 'public')));

/* ── Routes ── */
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/content',     require('./routes/content'));
app.use('/api/scores',      require('./routes/scores'));
app.use('/api/upload',      require('./routes/upload'));
app.use('/api/problems',    require('./routes/problems'));
app.use('/api/submissions', require('./routes/submissions'));

/* ── Health check ── */
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

/* ── Fallback: trả về index.html cho mọi route không khớp ── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── Error handler ── */
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
  console.log(`🌐 Trong mạng LAN: http://<IP-máy-bạn>:${PORT}`);
});
