const express = require('express');
const http = require('http');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, {
  cors: { origin: '*' } // lock this down later
});

const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });
app.use('/uploads', express.static(uploadDir));

const db = new sqlite3.Database(path.join(__dirname, 'chat.db'));
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      sender TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/messages', (req, res) => {
  const limit = Number(req.query.limit || 100);
  db.all(
    'SELECT id, text, sender, timestamp FROM messages ORDER BY id DESC LIMIT ?',
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db_error' });
      res.json(rows.reverse());
    }
  );
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname, mime: req.file.mimetype });
});

io.on('connection', socket => {
  socket.on('chat:send', msg => {
    const message = {
      id: Date.now(),
      text: msg.text,
      sender: msg.sender || 'Anonymous',
      timestamp: new Date().toISOString()
    };

    db.run(
      'INSERT INTO messages (id, text, sender, timestamp) VALUES (?, ?, ?, ?)',
      [message.id, message.text, message.sender, message.timestamp]
    );

    io.emit('chat:new', message);
  });
});

server.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}`);
});