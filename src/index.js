require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const app     = express();

/* ── CORS: cho phép frontend gọi API ── */
app.use(cors({
  origin: function(origin, cb) {
    // Cho phép: không có origin (Postman), localhost, và FRONTEND_URL
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:3000',
    ].filter(Boolean);

    if (!origin || allowed.some(u => origin.startsWith(u.replace(/\/$/, ''))))
      return cb(null, true);

    // Cho phép GitHub Pages (*.github.io)
    if (origin && origin.endsWith('.github.io'))
      return cb(null, true);

    cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' })); // cần thiết để upload file base64

/* ── Routes ── */
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/users',   require('./routes/users'));
app.use('/api/content', require('./routes/content'));
app.use('/api/scores',  require('./routes/scores'));
app.use('/api/upload',  require('./routes/upload'));

/* ── Health check ── */
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

/* ── Error handler ── */
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server chạy tại http://localhost:${PORT}`));
