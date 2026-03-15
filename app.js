const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let onlineUsers = [];
let mutedIPs = [];
const ADMIN_PASSWORD = 'Lmx%%112233';
let privateChatMap = new Map();

const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接数据库');
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      isAdmin INTEGER DEFAULT 0,
      isNotice INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip TEXT,
      isPrivate INTEGER DEFAULT 0,
      privateTarget TEXT DEFAULT '',
      isImage INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS muted_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT UNIQUE NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.all('SELECT ip FROM muted_ips', (err, rows) => {
      if (!err) mutedIPs = rows.map(row => row.ip);
    });
  }
});

// 图片上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public/uploads');
    require('fs').mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = Date.now() + '_' + Math.random().toString(36).substr(2, 6) + ext;
    cb(null, filename);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress || '';
}

function broadcastSystemMessage(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: new Date().toLocaleString() });
  onlineUsers.forEach(u => {
    if (u.ws.readyState === WebSocket.OPEN) u.ws.send(msg);
  });
}

function updateOnlineCount() {
  const count = onlineUsers.filter(u => !u.isMuted).length;
  broadcastSystemMessage('onlineCount', count);
}

function findUserByIP(ip) {
  return onlineUsers.find(u => u.ip === ip);
}

// 上传图片接口
app.post('/api/upload/image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: '未上传图片' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ success: true, url });
});

app.post('/api/admin/delete-message', (req, res) => {
  const { messageId } = req.body;
  if (!messageId || isNaN(Number(messageId))) return res.status(400).json({ success: false });
  db.run('DELETE FROM messages WHERE id = ?', [Number(messageId)], function (err) {
    if (err) return res.status(500).json({ success: false });
    broadcastSystemMessage('messageDeleted', { id: messageId });
    res.json({ success: true });
  });
});

app.post('/api/admin/clear-messages', (req, res) => {
  db.run('DELETE FROM messages WHERE isNotice=0 AND isPrivate=0', function (err) {
    if (err) return res.status(500).json({ success: false });
    broadcastSystemMessage('messagesCleared', {});
    res.json({ success: true });
  });
});

app.post('/api/admin/delete-notice', (req, res) => {
  const { noticeId } = req.body;
  if (!noticeId || isNaN(Number(noticeId))) return res.status(400).json({ success: false });
  db.run('DELETE FROM messages WHERE id=? AND isNotice=1', [Number(noticeId)], function (err) {
    if (err) return res.status(500).json({ success: false });
    broadcastSystemMessage('noticeDeleted', { id: noticeId });
    res.json({ success: true });
  });
});

app.get('/api/messages', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY timestamp ASC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true, token: 'admin_' + Date.now() });
  else res.status(401).json({ success: false });
});

app.get('/api/admin/online-users', (req, res) => {
  res.json(onlineUsers.map(u => ({ ip: u.ip, username: u.username || '未命名', isMuted: u.isMuted })));
});

app.post('/api/admin/mute-ip', (req, res) => {
  const { ip, mute } = req.body;
  if (!ip) return;
  if (mute) {
    db.run('INSERT OR IGNORE INTO muted_ips(ip) VALUES(?)', [ip], () => {
      if (!mutedIPs.includes(ip)) mutedIPs.push(ip);
      onlineUsers.forEach(u => {
        if (u.ip === ip) { u.isMuted = true; u.ws.send(JSON.stringify({ type: 'muted' })); u.ws.close(); }
      });
      updateOnlineCount();
      res.json({ success: true });
    });
  } else {
    db.run('DELETE FROM muted_ips WHERE ip=?', [ip], () => {
      mutedIPs = mutedIPs.filter(i => i !== ip);
      res.json({ success: true });
    });
  }
});

app.post('/api/admin/notice', (req, res) => {
  const { content } = req.body;
  if (!content) return;
  db.run('INSERT INTO messages(username,content,isAdmin,isNotice,ip) VALUES(?,?,1,1,?)',
    ['系统公告', content, 'admin'], () => {
      broadcastSystemMessage('notice', { username: '系统公告', content });
      res.json({ success: true });
    });
});

app.get('/health', (req, res) => {
  res.json({ status: 'alive', mutedIPs });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = getClientIP(req);
  if (mutedIPs.includes(ip)) { ws.send(JSON.stringify({ type: 'muted' })); ws.close(); return; }
  const user = { ws, ip, username: '', isMuted: false };
  onlineUsers.push(user);
  updateOnlineCount();

  ws.on('message', (data) => {
    try {
      const d = JSON.parse(data);
      const username = (d.username || '').trim();
      const content = (d.content || '').trim();
      const isAdmin = !!d.isAdmin;
      const isPrivate = !!d.isPrivate;
      const targetIP = (d.targetIP || '').trim();
      const isImage = !!d.isImage;

      if (!username) return;
      user.username = username;

      if (isPrivate && targetIP) {
        const tu = findUserByIP(targetIP);
        if (!tu) return;
        db.run('INSERT INTO messages(username,content,isAdmin,isPrivate,privateTarget,ip,isImage) VALUES(?,?,?,1,?,?,?)',
          [username, content, isAdmin ? 1 : 0, targetIP, ip, isImage ? 1 : 0]);
        const pmsg = JSON.stringify({
          type: 'privateChat',
          data: { from: { username, ip }, to: { ip: targetIP }, content, isImage, timestamp: new Date().toLocaleString() }
        });
        ws.send(pmsg);
        tu.ws.send(pmsg);
        return;
      }

      db.run('INSERT INTO messages(username,content,isAdmin,ip,isImage) VALUES(?,?,?,?,?)',
        [username, content, isAdmin ? 1 : 0, ip, isImage ? 1 : 0]);

      const msg = JSON.stringify({
        type: 'chat',
        data: { username, content, isAdmin, isImage, timestamp: new Date().toLocaleString() }
      });
      onlineUsers.forEach(u => u.ws.readyState === WebSocket.OPEN && u.ws.send(msg));
    } catch (e) { }
  });

  ws.on('close', () => {
    onlineUsers = onlineUsers.filter(u => u.ws !== ws);
    updateOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`启动成功 :${PORT}`));
