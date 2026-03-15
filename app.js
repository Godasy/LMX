const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

let onlineUsers = [];
let mutedIPs = [];
const ADMIN_PASSWORD = 'Lmx%%112233';

// 数据库
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('DB 打开失败', err);
  else console.log('数据库已连接');

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    content TEXT,
    image TEXT,
    isAdmin INTEGER DEFAULT 0,
    isNotice INTEGER DEFAULT 0,
    isPrivate INTEGER DEFAULT 0,
    privateTarget TEXT DEFAULT '',
    ip TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS muted_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT UNIQUE NOT NULL
  )`);

  db.all('SELECT ip FROM muted_ips', (err, rows) => {
    if (!err) mutedIPs = rows.map(r => r.ip);
  });
});

// 工具
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] ||
    req.connection.remoteAddress || '';
}

function broadcast(msg) {
  onlineUsers.forEach(u => {
    if (u.ws.readyState === WebSocket.OPEN) u.ws.send(msg);
  });
}

function updateOnline() {
  const cnt = onlineUsers.filter(u => !u.isMuted).length;
  broadcast(JSON.stringify({ type: 'onlineCount', data: cnt }));
}

function findUserByIP(ip) {
  return onlineUsers.find(u => u.ip === ip);
}

// 消息历史
app.get('/api/messages', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY timestamp ASC', (err, rows) => {
    res.json(rows || []);
  });
});

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD)
    res.json({ success: true, token: 'ok' });
  else res.json({ success: false });
});

// 在线用户
app.get('/api/admin/online-users', (req, res) => {
  res.json(onlineUsers.map(u => ({
    ip: u.ip,
    username: u.username || '匿名',
    isMuted: u.isMuted
  })));
});

// 禁言
app.post('/api/admin/mute-ip', (req, res) => {
  const { ip, mute } = req.body;
  if (!ip) return res.json({ success: false });

  if (mute) {
    db.run('INSERT OR IGNORE INTO muted_ips(ip) VALUES(?)', [ip]);
    if (!mutedIPs.includes(ip)) mutedIPs.push(ip);
    onlineUsers.forEach(u => {
      if (u.ip === ip) { u.isMuted = true; u.ws.close(); }
    });
  } else {
    db.run('DELETE FROM muted_ips WHERE ip=?', [ip]);
    mutedIPs = mutedIPs.filter(i => i !== ip);
  }
  updateOnline();
  res.json({ success: true });
});

// 发公告
app.post('/api/admin/notice', (req, res) => {
  const { content, image } = req.body;
  db.run(
    'INSERT INTO messages (username, content, image, isAdmin, isNotice, ip) VALUES(?,?,?,1,1,?)',
    ['系统公告', content || '', image || '', 'admin']
  );
  broadcast(JSON.stringify({
    type: 'notice',
    data: { username: '系统公告', content, image, timestamp: new Date().toLocaleString() }
  }));
  res.json({ success: true });
});

// 删除消息
app.post('/api/admin/delete-message', (req, res) => {
  db.run('DELETE FROM messages WHERE id=?', [req.body.messageId]);
  broadcast(JSON.stringify({ type: 'messageDeleted', id: req.body.messageId }));
  res.json({ success: true });
});

// 清空聊天
app.post('/api/admin/clear-messages', (req, res) => {
  db.run('DELETE FROM messages WHERE isNotice=0 AND isPrivate=0');
  broadcast(JSON.stringify({ type: 'messagesCleared' }));
  res.json({ success: true });
});

// 删除公告
app.post('/api/admin/delete-notice', (req, res) => {
  db.run('DELETE FROM messages WHERE id=? AND isNotice=1', [req.body.noticeId]);
  broadcast(JSON.stringify({ type: 'noticeDeleted', id: req.body.noticeId }));
  res.json({ success: true });
});

app.get('/health', (req, res) => res.json({ alive: true, mutedIPs }));

// WS
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = getClientIP(req);
  if (mutedIPs.includes(ip)) { ws.close(); return; }

  const user = { ws, ip, username: '', isMuted: false };
  onlineUsers.push(user);
  updateOnline();

  ws.on('message', (data) => {
    try {
      const d = JSON.parse(data);
      const username = (d.username || '匿名').slice(0, 10);
      const content = (d.content || '').slice(0, 500);
      const image = (d.image || '').slice(0, 500000);
      const isPrivate = d.isPrivate;
      const targetIP = d.targetIP;

      user.username = username;

      if (isPrivate && targetIP) {
        const tu = findUserByIP(targetIP);
        if (!tu) return;
        db.run(
          'INSERT INTO messages (username, content, image, isPrivate, privateTarget, ip) VALUES(?,?,?,1,?,?)',
          [username, content, image, targetIP, ip]
        );
        const msg = JSON.stringify({
          type: 'privateChat',
          data: { from: { username, ip }, to: { ip: targetIP }, content, image, timestamp: new Date().toLocaleString() }
        });
        ws.send(msg);
        tu.ws.send(msg);
        return;
      }

      // 普通消息/图片
      db.run(
        'INSERT INTO messages (username, content, image, ip) VALUES(?,?,?,?)',
        [username, content, image, ip]
      );

      broadcast(JSON.stringify({
        type: 'chat',
        data: { username, content, image, timestamp: new Date().toLocaleString() }
      }));

    } catch (e) {}
  });

  ws.on('close', () => {
    onlineUsers = onlineUsers.filter(u => u.ws !== ws);
    updateOnline();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('启动成功'));
