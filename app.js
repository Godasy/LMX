const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'Lmx%%112233';

let onlineUsers = [];
let chatRooms = [
  { id: 'default', name: '默认聊天室', desc: '所有人可进入的公共聊天室' }
];

const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接SQLite数据库');
    createTables();
    loadChatRoomsFromDB();
  }
});

function createTables() {
  db.run(`CREATE TABLE IF NOT EXISTS chatrooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    desc TEXT,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_red INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS friend_applies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_id TEXT NOT NULL,
    status INTEGER DEFAULT 0,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

function loadChatRoomsFromDB() {
  db.all('SELECT * FROM chatrooms', (err, rows) => {
    if (!err && rows.length > 0) {
      chatRooms = rows;
    } else {
      db.run('INSERT OR IGNORE INTO chatrooms (id, name, desc) VALUES (?, ?, ?)',
        ['default', '默认聊天室', '所有人可进入的公共聊天室']);
    }
  });
}

function broadcastToAll(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function getClientIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress || '';
  return ip.replace(/::ffff:/, '');
}

app.get('/api/chatrooms', (req, res) => {
  res.json({ success: true, rooms: chatRooms });
});

app.post('/api/chatrooms', (req, res) => {
  const { name, desc, adminPwd } = req.body;
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  if (!name) return res.json({ success: false, message: '名称不能为空' });

  const roomId = 'room_' + Date.now();
  db.run('INSERT INTO chatrooms (id, name, desc) VALUES (?, ?, ?)',
    [roomId, name, desc || ''], (err) => {
      if (err) return res.json({ success: false });
      const newRoom = { id: roomId, name, desc: desc || '' };
      chatRooms.push(newRoom);
      broadcastToAll({ type: 'chatRooms', rooms: chatRooms });
      res.json({ success: true, room: newRoom });
    });
});

app.delete('/api/chatrooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const { adminPwd } = req.body;
  if (adminPwd !== ADMIN_PASSWORD) return res.json({ success: false });
  if (roomId === 'default') return res.json({ success: false });

  db.run('DELETE FROM chatrooms WHERE id = ?', [roomId]);
  db.run('DELETE FROM messages WHERE room_id = ?', [roomId]);
  chatRooms = chatRooms.filter(r => r.id !== roomId);
  broadcastToAll({ type: 'chatRooms', rooms: chatRooms });
  res.json({ success: true });
});

app.get('/api/chatrooms/:roomId/messages', (req, res) => {
  const { roomId } = req.params;
  db.all('SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC',
    [roomId], (err, rows) => {
      res.json({ success: true, messages: rows || [] });
    });
});

app.post('/api/admin/notice', (req, res) => {
  const { content, adminPwd } = req.body;
  if (adminPwd !== ADMIN_PASSWORD) return res.json({ success: false });
  if (!content) return res.json({ success: false });

  db.run('INSERT INTO notices (content) VALUES (?)', [content]);
  broadcastToAll({
    type: 'notice',
    content,
    timestamp: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
  });
  res.json({ success: true });
});

app.post('/api/admin/red-message', (req, res) => {
  const { content, roomId, adminPwd } = req.body;
  if (adminPwd !== ADMIN_PASSWORD) return res.json({ success: false });
  if (!content) return res.json({ success: false });

  const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (roomId) {
    db.run('INSERT INTO messages (room_id, username, content, is_admin, is_red, timestamp) VALUES (?, ?, ?, 1, 1, ?)',
      [roomId, '管理员', content, timestamp]);
  }
  broadcastToAll({
    type: 'adminRedMessage',
    content,
    roomId: roomId || '',
    timestamp
  });
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'alive', online: onlineUsers.length, rooms: chatRooms.length });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = getClientIP(req);
  let userInfo = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'online':
          userInfo = { id: msg.userId, name: msg.userName, ip, ws };
          onlineUsers.push(userInfo);
          break;

        case 'chat':
          const chatMsg = {
            type: 'chat',
            data: {
              roomId: msg.roomId,
              username: msg.username,
              content: msg.content,
              timestamp: msg.timestamp,
              isAdmin: msg.isAdmin
            }
          };
          db.run('INSERT INTO messages (room_id, username, content, is_admin, timestamp) VALUES (?, ?, ?, ?, ?)',
            [msg.roomId, msg.username, msg.content, msg.isAdmin ? 1 : 0, msg.timestamp]);
          broadcastToAll(chatMsg);
          break;

        case 'privateChat':
          const pvMsg = {
            type: 'privateChat',
            data: { from: msg.from, to: msg.to, content: msg.content, timestamp: msg.timestamp }
          };
          const to = onlineUsers.find(u => u.id === msg.to.id);
          if (to) to.ws.send(JSON.stringify(pvMsg));
          ws.send(JSON.stringify(pvMsg));
          break;

        case 'friendApply':
          const apply = {
            type: 'friendApply',
            data: { fromId: msg.fromId, fromName: msg.fromName, toId: msg.toId }
          };
          db.run('INSERT INTO friend_applies (from_id, from_name, to_id) VALUES (?, ?, ?)',
            [msg.fromId, msg.fromName, msg.toId]);
          const target = onlineUsers.find(u => u.id === msg.toId);
          if (target) target.ws.send(JSON.stringify(apply));
          break;

        case 'friendAgree':
          db.run('UPDATE friend_applies SET status=1 WHERE from_id=? AND to_id=?', [msg.toId, msg.fromId]);
          db.run('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', [msg.fromId, msg.toId]);
          db.run('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', [msg.toId, msg.fromId]);

          const agreeMsg = {
            type: 'friendAgree',
            data: { friend: { id: msg.fromId, name: msg.fromName } }
          };
          const applyUser = onlineUsers.find(u => u.id === msg.toId);
          if (applyUser) applyUser.ws.send(JSON.stringify(agreeMsg));
          break;
      }
    } catch (e) { }
  });

  ws.on('close', () => {
    if (userInfo) {
      onlineUsers = onlineUsers.filter(u => u.id !== userInfo.id);
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log('服务器启动成功，端口：', PORT);
});
