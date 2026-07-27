const express = require('express');
const http = require('http');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { fromFile } = require('file-type');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

const ALLOWED_ROOMS = ['catchat 1', 'catchat 2', 'catchat 3', 'catchatbeta', 'beta'];

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(__dirname, 'chat.db');
const dbDirectory = path.dirname(dbPath);
if (!fs.existsSync(dbDirectory)) fs.mkdirSync(dbDirectory, { recursive: true });

const upload = multer({ dest: uploadDir });
app.use('/uploads', express.static(uploadDir));

// Changed from const to let so db can be reassigned during database restore
let db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to open SQLite database:', err.message);
    process.exit(1);
  }
});

// Setup DB schema including file metadata columns
function initDatabaseSchema() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        room TEXT NOT NULL DEFAULT 'catchat 1',
        text TEXT NOT NULL,
        sender TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        fileUrl TEXT,
        fileName TEXT,
        fileType TEXT
      )
    `);

    // Safe migrations in case table exists without these columns
    db.run(`ALTER TABLE messages ADD COLUMN room TEXT NOT NULL DEFAULT 'catchat 1'`, () => {});
    db.run(`ALTER TABLE messages ADD COLUMN fileUrl TEXT`, () => {});
    db.run(`ALTER TABLE messages ADD COLUMN fileName TEXT`, () => {});
    db.run(`ALTER TABLE messages ADD COLUMN fileType TEXT`, () => {});
  });
}

initDatabaseSchema();

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/messages', (req, res) => {
  const room = req.query.room || 'catchat 1';
  const limit = Number(req.query.limit || 100);

  db.all(
    'SELECT id, room, text, sender, timestamp, fileUrl, fileName, fileType FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?',
    [room, limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db_error' });
      res.json(rows.reverse());
    }
  );
});

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  
  const url = `/uploads/${req.file.filename}`;
  const filePath = req.file.path;
  
  let mimeType = 'application/octet-stream';
  try {
    const fileTypeResult = await fromFile(filePath);
    if (fileTypeResult && fileTypeResult.mime) {
      mimeType = fileTypeResult.mime;
    } else if (req.file.mimetype) {
      mimeType = req.file.mimetype;
    }
  } catch (error) {
    console.error('Error detecting file type:', error);
    mimeType = req.file.mimetype || 'application/octet-stream';
  }
  
  res.json({ url, name: req.file.originalname, mime: mimeType });
});

// Endpoint to download the database file (Backup)
app.get('/backup', (req, res) => {
  res.download(dbPath, 'chat.db', (err) => {
    if (err) {
      console.error('Error downloading backup:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'backup_failed' });
      }
    }
  });
});

// Endpoint to restore database from an uploaded .db file (Restore)
app.post('/restore', upload.single('database'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  // Close existing database connection safely
  db.close((err) => {
    if (err) console.error('Error closing database prior to restore:', err);

    // Overwrite existing chat.db file with uploaded file
    fs.copyFile(req.file.path, dbPath, (copyErr) => {
      fs.unlink(req.file.path, () => {}); // Clean temp upload

      if (copyErr) {
        console.error('Failed to overwrite database:', copyErr);
        return res.status(500).json({ error: 'restore_failed' });
      }

      // Re-open database connection
      db = new sqlite3.Database(dbPath, (reopenErr) => {
        if (reopenErr) {
          console.error('Error reopening database:', reopenErr);
          return res.status(500).json({ error: 'db_reopen_failed' });
        }
        initDatabaseSchema();
        res.json({ success: true, message: 'Database restored successfully!' });
      });
    });
  });
});

io.on('connection', socket => {
  let currentRoom = 'catchat 1';
  socket.join(currentRoom);

  socket.on('room:join', (targetRoom) => {
    socket.leave(currentRoom);
    socket.join(targetRoom);
    currentRoom = targetRoom;
  });

  socket.on('chat:send', msg => {
    const room = msg.room || currentRoom;
    const message = {
      id: msg.id || Date.now(),
      room: room,
      text: msg.text || '',
      sender: msg.sender || 'Anonymous',
      timestamp: msg.timestamp || new Date().toISOString(),
      fileUrl: msg.fileUrl || null,
      fileName: msg.fileName || null,
      fileType: msg.fileType || null
    };

    db.run(
      'INSERT INTO messages (id, room, text, sender, timestamp, fileUrl, fileName, fileType) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [message.id, message.room, message.text, message.sender, message.timestamp, message.fileUrl, message.fileName, message.fileType]
    );

    io.to(room).emit('chat:new', message);
  });
});

server.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}`);
});