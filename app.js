const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 数据库初始化
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) console.error('DB 错误:', err.message);
  else console.log('连接到 SQLite 数据库');
});

// 创建表
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    pwd TEXT NOT NULL,
    name TEXT NOT NULL,
    create_time INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS chatrooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    create_time INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_red INTEGER DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    friend_name TEXT NOT NULL,
    create_time INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS friend_applies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    create_time INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    create_time INTEGER NOT NULL
  )
`);

// 全局状态
const clients = new Map(); // userId -> ws
const rooms = new Map(); // roomId -> Set(userId)

// 广播
function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client !== exclude) {
      client.send(msg);
    }
  });
}

// 发送给指定用户
function sendToUser(userId, data) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// 发送到房间
function sendToRoom(roomId, data, exclude = null) {
  const msg = JSON.stringify(data);
  const users = rooms.get(roomId) || new Set();
  users.forEach((uid) => {
    const ws = clients.get(uid);
    if (ws && ws.readyState === WebSocket.OPEN && uid !== exclude) {
      ws.send(msg);
    }
  });
}

// WebSocket 连接
wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(ws, msg);
    } catch (e) {
      console.error('解析消息失败:', e);
    }
  });

  ws.on('close', () => {
    if (currentUser) {
      clients.delete(currentUser.id);
      rooms.forEach((users) => users.delete(currentUser.id));
    }
  });

  function handleMessage(ws, msg) {
    switch (msg.type) {
      case 'online':
        handleOnline(ws, msg);
        break;
      case 'chat':
        handleChat(ws, msg);
        break;
      case 'privateChat':
        handlePrivateChat(ws, msg);
        break;
      case 'friendApply':
        handleFriendApply(ws, msg);
        break;
      case 'friendAgree':
        handleFriendAgree(ws, msg);
        break;
      case 'createRoom':
        handleCreateRoom(ws, msg);
        break;
      case 'sendNotice':
        handleSendNotice(ws, msg);
        break;
      case 'sendAdminRed':
        handleAdminRed(ws, msg);
        break;
    }
  }

  function handleOnline(ws, msg) {
    currentUser = { id: msg.userId, name: msg.userName };
    clients.set(msg.userId, ws);
    sendLatestNotice(ws);
  }

  function handleChat(ws, msg) {
    const { roomId, username, content, timestamp, isAdmin } = msg;
    db.run(
      `INSERT INTO messages (room_id, username, content, timestamp, is_admin)
       VALUES (?, ?, ?, ?, ?)`,
      [roomId, username, content, timestamp, isAdmin ? 1 : 0],
      (err) => {
        if (err) console.error('保存消息失败:', err);
        else {
          sendToRoom(roomId, {
            type: 'chat',
            data: { roomId, username, content, timestamp, isAdmin }
          });
        }
      }
    );
  }

  function handlePrivateChat(ws, msg) {
    const { from, to, content, timestamp } = msg;
    sendToUser(to.id, {
      type: 'privateChat',
      data: { from, to, content, timestamp }
    });
    // 回发给自己
    ws.send(JSON.stringify({
      type: 'privateChat',
      data: { from, to, content, timestamp }
    }));
  }

  function handleFriendApply(ws, msg) {
    const { fromId, fromName, toId } = msg;
    db.run(
      `INSERT INTO friend_applies (from_id, from_name, to_id, create_time)
       VALUES (?, ?, ?, ?)`,
      [fromId, fromName, toId, Date.now()],
      (err) => {
        if (err) console.error('申请失败:', err);
        else {
          sendToUser(toId, {
            type: 'friendApply',
            data: { fromId, fromName, toId }
          });
        }
      }
    );
  }

  function handleFriendAgree(ws, msg) {
    const { fromId, fromName, toId } = msg;
    // 双向添加好友
    db.run(
      `INSERT INTO friends (user_id, friend_id, friend_name, create_time)
       VALUES (?, ?, ?, ?)`,
      [fromId, toId, fromName, Date.now()]
    );
    db.run(
      `INSERT INTO friends (user_id, friend_id, friend_name, create_time)
       VALUES (?, ?, ?, ?)`,
      [toId, fromId, fromName, Date.now()]
    );
    // 更新申请状态
    db.run(
      `UPDATE friend_applies SET status = 'agree'
       WHERE from_id = ? AND to_id = ?`,
      [fromId, toId]
    );
    // 通知双方
    sendToUser(fromId, {
      type: 'friendAgree',
      data: { friend: { id: toId, name: fromName } }
    });
    sendToUser(toId, {
      type: 'friendAgree',
      data: { friend: { id: fromId, name: fromName } }
    });
  }

  function handleCreateRoom(ws, msg) {
    const { roomId, name, desc } = msg;
    db.run(
      `INSERT INTO chatrooms (id, name, description, create_time)
       VALUES (?, ?, ?, ?)`,
      [roomId, name, desc, Date.now()],
      (err) => {
        if (err) console.error('创建房间失败:', err);
        else {
          rooms.set(roomId, new Set());
          broadcast({ type: 'chatRooms', rooms: getRooms() });
        }
      }
    );
  }

  function handleSendNotice(ws, msg) {
    const { content } = msg;
    db.run(
      `INSERT INTO notices (content, create_time) VALUES (?, ?)`,
      [content, Date.now()],
      (err) => {
        if (err) console.error('发送公告失败:', err);
        else {
          broadcast({ type: 'notice', content });
        }
      }
    );
  }

  function handleAdminRed(ws, msg) {
    const { content, timestamp } = msg;
    broadcast({
      type: 'adminRedMessage',
      content,
      timestamp
    });
  }

  function sendLatestNotice(ws) {
    db.get(
      `SELECT content FROM notices ORDER BY create_time DESC LIMIT 1`,
      (err, row) => {
        if (!err && row) {
          ws.send(JSON.stringify({ type: 'notice', content: row.content }));
        }
      }
    );
  }
});

// API 路由
app.get('/api/chatrooms', (req, res) => {
  db.all(`SELECT * FROM chatrooms`, (err, rows) => {
    if (err) res.json({ success: false, error: err.message });
    else res.json({ success: true, rooms: rows });
  });
});

app.get('/api/chatrooms/:id/messages', (req, res) => {
  const roomId = req.params.id;
  db.all(
    `SELECT * FROM messages WHERE room_id = ? ORDER BY id ASC`,
    [roomId],
    (err, rows) => {
      if (err) res.json({ success: false, error: err.message });
      else res.json({ success: true, messages: rows });
    }
  );
});

app.post('/api/register', (req, res) => {
  const { id, pwd, name } = req.body;
  db.get(`SELECT id FROM users WHERE id = ?`, [id], (err, row) => {
    if (row) return res.json({ success: false, error: 'ID 已存在' });
    db.run(
      `INSERT INTO users (id, pwd, name, create_time) VALUES (?, ?, ?, ?)`,
      [id, pwd, name, Date.now()],
      (err) => {
        if (err) res.json({ success: false, error: err.message });
        else res.json({ success: true });
      }
    );
  });
});

app.post('/api/login', (req, res) => {
  const { id, pwd } = req.body;
  db.get(`SELECT * FROM users WHERE id = ? AND pwd = ?`, [id, pwd], (err, row) => {
    if (!row) res.json({ success: false, error: 'ID 或密码错误' });
    else res.json({ success: true, user: { id: row.id, name: row.name } });
  });
});

app.post('/api/delete-account', (req, res) => {
  const { id } = req.body;
  db.run(`DELETE FROM users WHERE id = ?`, [id], (err) => {
    if (err) res.json({ success: false, error: err.message });
    else {
      db.run(`DELETE FROM friends WHERE user_id = ? OR friend_id = ?`, [id, id]);
      db.run(`DELETE FROM friend_applies WHERE from_id = ? OR to_id = ?`, [id, id]);
      res.json({ success: true });
    }
  });
});

function getRooms() {
  return new Promise((resolve) => {
    db.all(`SELECT * FROM chatrooms`, (err, rows) => resolve(rows || []));
  });
}

// 启动
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
