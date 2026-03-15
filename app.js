const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

let onlineUsers = [];
let mutedIPs = [];
const ADMIN_PASSWORD = 'Lmx%%112233';

const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('数据库连接失败:', err.message);
  else console.log('成功连接 SQLite 数据库');

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    isAdmin INTEGER DEFAULT 0,
    isNotice INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip TEXT,
    isPrivate INTEGER DEFAULT 0,
    privateTarget TEXT DEFAULT ''
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS muted_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT UNIQUE NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.all('SELECT ip FROM muted_ips', (err, rows) => {
    if (!err) mutedIPs = rows.map(row => row.ip);
  });
});

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

// ================= 关键：检查是否和在线用户重名 =================
function isUsernameOnline(username) {
  if (!username) return false;
  return onlineUsers.some(u =>
    u.username && u.username.trim().toLowerCase() === username.trim().toLowerCase()
  );
}

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin_' + Date.now() });
  } else {
    res.status(401).json({ success: false, message: '密码错误' });
  }
});

// 在线用户
app.get('/api/admin/online-users', (req, res) => {
  res.json(onlineUsers.map(u => ({
    ip: u.ip,
    username: u.username || '未命名',
    isMuted: u.isMuted
  })));
});

// 禁言
app.post('/api/admin/mute-ip', (req, res) => {
  const { ip, mute } = req.body;
  if (!ip) return res.status(400).json({ success: false });

  if (mute) {
    db.run('INSERT OR IGNORE INTO muted_ips (ip) VALUES (?)', [ip], () => {
      if (!mutedIPs.includes(ip)) mutedIPs.push(ip);
      onlineUsers.forEach(u => {
        if (u.ip === ip) {
          u.isMuted = true;
          u.ws.send(JSON.stringify({ type: 'muted', message: '你已被禁言' }));
          u.ws.close();
        }
      });
      updateOnlineCount();
      res.json({ success: true, message: '禁言成功' });
    });
  } else {
    db.run('DELETE FROM muted_ips WHERE ip = ?', [ip], () => {
      mutedIPs = mutedIPs.filter(i => i !== ip);
      res.json({ success: true, message: '解除禁言成功' });
    });
  }
});

// 删除消息
app.post('/api/admin/delete-message', (req, res) => {
  const { messageId } = req.body;
  if (!messageId || isNaN(messageId)) return res.status(400).json({ success: false });
  db.run('DELETE FROM messages WHERE id = ?', [messageId], function () {
    broadcastSystemMessage('messageDeleted', { id: messageId });
    res.json({ success: true, message: '删除成功' });
  });
});

// 清空聊天
app.post('/api/admin/clear-messages', (req, res) => {
  db.run('DELETE FROM messages WHERE isNotice=0 AND isPrivate=0', () => {
    broadcastSystemMessage('messagesCleared', {});
    res.json({ success: true, message: '已清空' });
  });
});

// 删除公告
app.post('/api/admin/delete-notice', (req, res) => {
  const { noticeId } = req.body;
  db.run('DELETE FROM messages WHERE id=? AND isNotice=1', [noticeId], () => {
    broadcastSystemMessage('noticeDeleted', { id: noticeId });
    res.json({ success: true, message: '公告已删除' });
  });
});

// 发公告
app.post('/api/admin/notice', (req, res) => {
  const { content } = req.body;
  db.run('INSERT INTO messages (username,content,isAdmin,isNotice,ip) VALUES (?,?,1,1,?)',
    ['系统公告', content, 'admin'], () => {
      broadcastSystemMessage('notice', { username: '系统公告', content });
      res.json({ success: true });
    });
});

// 历史消息
app.get('/api/messages', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY timestamp ASC', (err, rows) => {
    res.json(rows);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'alive', mutedIPs });
});

// ==================== WebSocket ====================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = getClientIP(req);
  if (mutedIPs.includes(ip)) {
    ws.send(JSON.stringify({ type: 'muted' }));
    ws.close();
    return;
  }

  const user = { ws, ip, username: '', isMuted: false };
  onlineUsers.push(user);
  updateOnlineCount();

  ws.on('message', (data) => {
    try {
      const d = JSON.parse(data);
      const username = (d.username || '').trim();
      const content = (d.content || '').trim();
      const isPrivate = !!d.isPrivate;
      const targetIP = d.targetIP;

      if (!username || !content) return;

      // ================= 核心：禁止重名 =================
      if (user.username !== username && isUsernameOnline(username)) {
        ws.send(JSON.stringify({
          type: 'error',
          message: '昵称已被在线用户使用，请换一个'
        }));
        return;
      }

      user.username = username;

      if (isPrivate && targetIP) {
        const tu = findUserByIP(targetIP);
        if (!tu) return ws.send(JSON.stringify({ type: 'error', message: '对方不在线' }));

        db.run('INSERT INTO messages (username,content,isPrivate,privateTarget,ip) VALUES (?,1,?,?)',
          [username, content, targetIP, ip]);

        const pmsg = JSON.stringify({
          type: 'privateChat',
          data: { from: { username, ip }, to: { ip: targetIP }, content }
        });
        ws.send(pmsg);
        if (tu.ws.readyState === WebSocket.OPEN) tu.ws.send(pmsg);
        return;
      }

      db.run('INSERT INTO messages (username,content,ip) VALUES (?,?,?)', [username, content, ip]);
      broadcastSystemMessage('chat', { username, content });

    } catch (e) { }
  });

  ws.on('close', () => {
    onlineUsers = onlineUsers.filter(u => u.ws !== ws);
    updateOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('服务已启动'));
