const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

let onlineUsers = new Map(); // { userId: { ws, userInfo } }
let chatRooms = ['公共聊天室']; // 默认聊天室
const ADMIN_PASSWORD = 'Lmx%%112233';
const PORT = process.env.PORT || 3000;

// 初始化数据库
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('数据库连接失败:', err);
  else {
    console.log('数据库连接成功');
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nickname TEXT NOT NULL,
      ip TEXT NOT NULL
    )`);
    // 好友表
    db.run(`CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId1 TEXT NOT NULL,
      userId2 TEXT NOT NULL,
      status INTEGER DEFAULT 0, -- 0:待同意 1:已同意
      createTime DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // 聊天室表
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roomName TEXT UNIQUE NOT NULL,
      createTime DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // 消息表
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roomName TEXT,
      fromUserId TEXT,
      toUserId TEXT,
      content TEXT,
      isAdmin INTEGER DEFAULT 0,
      isNotice INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // 初始化默认聊天室
    db.run('INSERT OR IGNORE INTO rooms (roomName) VALUES (?)', ['公共聊天室']);
  }
});

// 工具函数
function getClientIP(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.connection.remoteAddress || '').replace(/[^0-9a-fA-F:\.]/g, '');
}
function getTime() {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}
function broadcastToRoom(roomName, type, data) {
  const msg = JSON.stringify({ type, data, timestamp: getTime() });
  onlineUsers.forEach((user) => {
    if (user.currentRoom === roomName && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(msg);
    }
  });
}
function broadcastToUser(userId, type, data) {
  const user = onlineUsers.get(userId);
  if (user && user.ws.readyState === WebSocket.OPEN) {
    user.ws.send(JSON.stringify({ type, data, timestamp: getTime() }));
  }
}

// ==================== API接口 ====================
// 1. 用户注册
app.post('/api/register', (req, res) => {
  const { userId, password, nickname } = req.body;
  const ip = getClientIP(req);
  if (!userId || !password || !nickname) return res.status(400).json({ success: false, message: '信息不完整' });

  // 检查IP是否已注册
  db.get('SELECT * FROM users WHERE ip = ?', [ip], (err, row) => {
    if (row) return res.status(400).json({ success: false, message: '该IP已注册过账号' });
    // 检查ID是否已存在
    db.get('SELECT * FROM users WHERE userId = ?', [userId], (err, row) => {
      if (row) return res.status(400).json({ success: false, message: 'ID已被使用' });
      // 注册
      db.run('INSERT INTO users (userId, password, nickname, ip) VALUES (?, ?, ?, ?)', 
        [userId, password, nickname, ip], (err) => {
          if (err) return res.status(500).json({ success: false, message: '注册失败' });
          res.json({ success: true, message: '注册成功' });
        });
    });
  });
});

// 2. 用户登录
app.post('/api/login', (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) return res.status(400).json({ success: false, message: '信息不完整' });

  db.get('SELECT * FROM users WHERE userId = ? AND password = ?', [userId, password], (err, row) => {
    if (!row) return res.status(401).json({ success: false, message: 'ID或密码错误' });
    res.json({ 
      success: true, 
      user: { userId: row.userId, nickname: row.nickname }
    });
  });
});

// 3. 获取聊天室列表
app.get('/api/rooms', (req, res) => {
  db.all('SELECT * FROM rooms ORDER BY createTime DESC', (err, rows) => {
    res.json(rows || []);
  });
});

// 4. 获取好友列表
app.get('/api/friends/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT u.userId, u.nickname 
    FROM friends f 
    JOIN users u ON (f.userId1 = u.userId OR f.userId2 = u.userId)
    WHERE (f.userId1 = ? OR f.userId2 = ?) AND f.status = 1 AND u.userId != ?
  `;
  db.all(sql, [userId, userId, userId], (err, rows) => {
    res.json(rows || []);
  });
});

// 5. 获取好友申请列表
app.get('/api/friend-requests/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT f.id, u.userId as fromUserId, u.nickname as fromNickname 
    FROM friends f 
    JOIN users u ON f.userId1 = u.userId
    WHERE f.userId2 = ? AND f.status = 0
  `;
  db.all(sql, [userId], (err, rows) => {
    res.json(rows || []);
  });
});

// 6. 发送好友申请
app.post('/api/add-friend', (req, res) => {
  const { fromUserId, toUserId } = req.body;
  if (!fromUserId || !toUserId) return res.status(400).json({ success: false });
  
  // 检查是否已是好友
  const checkSql = 'SELECT * FROM friends WHERE (userId1 = ? AND userId2 = ?) OR (userId1 = ? AND userId2 = ?)';
  db.get(checkSql, [fromUserId, toUserId, toUserId, fromUserId], (err, row) => {
    if (row) return res.status(400).json({ success: false, message: '已是好友或已申请' });
    // 发送申请
    db.run('INSERT INTO friends (userId1, userId2, status) VALUES (?, ?, 0)', [fromUserId, toUserId], (err) => {
      if (err) return res.status(500).json({ success: false });
      // 通知对方
      broadcastToUser(toUserId, 'friendRequest', { fromUserId, fromNickname: fromUserId });
      res.json({ success: true });
    });
  });
});

// 7. 处理好友申请
app.post('/api/handle-friend', (req, res) => {
  const { requestId, agree } = req.body;
  if (!requestId) return res.status(400).json({ success: false });

  if (agree) {
    db.run('UPDATE friends SET status = 1 WHERE id = ?', [requestId], (err) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true });
    });
  } else {
    db.run('DELETE FROM friends WHERE id = ?', [requestId], (err) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true });
    });
  }
});

// 8. 删除好友
app.post('/api/delete-friend', (req, res) => {
  const { userId1, userId2 } = req.body;
  const sql = 'DELETE FROM friends WHERE (userId1 = ? AND userId2 = ?) OR (userId1 = ? AND userId2 = ?)';
  db.run(sql, [userId1, userId2, userId2, userId1], (err) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true });
  });
});

// 9. 获取历史消息（聊天室/私聊）
app.get('/api/messages', (req, res) => {
  const { roomName, userId1, userId2 } = req.query;
  let sql, params;
  
  if (roomName) {
    sql = 'SELECT * FROM messages WHERE roomName = ? ORDER BY timestamp ASC';
    params = [roomName];
  } else if (userId1 && userId2) {
    sql = `SELECT * FROM messages WHERE 
           (fromUserId = ? AND toUserId = ?) OR (fromUserId = ? AND toUserId = ?)
           ORDER BY timestamp ASC`;
    params = [userId1, userId2, userId2, userId1];
  } else {
    return res.status(400).json({ error: '参数错误' });
  }

  db.all(sql, params, (err, rows) => {
    res.json(rows || []);
  });
});

// 10. 获取公告
app.get('/api/notices', (req, res) => {
  db.all('SELECT * FROM messages WHERE isNotice = 1 ORDER BY timestamp DESC LIMIT 10', (err, rows) => {
    res.json(rows || []);
  });
});

// ==================== 管理员API ====================
app.post('/api/admin/add-room', (req, res) => {
  const { roomName, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false });
  db.run('INSERT OR IGNORE INTO rooms (roomName) VALUES (?)', [roomName], (err) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true });
  });
});

app.post('/api/admin/send-notice', (req, res) => {
  const { content, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false });
  
  const sql = 'INSERT INTO messages (content, isNotice, timestamp) VALUES (?, 1, ?)';
  db.run(sql, [content, getTime()], (err) => {
    if (err) return res.status(500).json({ success: false });
    // 广播给所有人
    onlineUsers.forEach((user) => {
      if (user.ws.readyState === WebSocket.OPEN) {
        user.ws.send(JSON.stringify({ type: 'notice', data: { content, timestamp: getTime() } }));
      }
    });
    res.json({ success: true });
  });
});

// ==================== WebSocket ====================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      // 1. 进入聊天室
      if (msg.type === 'joinRoom') {
        currentUser = {
          ws,
          userId: msg.userId,
          nickname: msg.nickname,
          currentRoom: msg.roomName
        };
        onlineUsers.set(msg.userId, currentUser);
        // 发送历史消息
        db.all('SELECT * FROM messages WHERE roomName = ? ORDER BY timestamp ASC', [msg.roomName], (err, rows) => {
          ws.send(JSON.stringify({ type: 'historyMessages', data: rows }));
        });
        return;
      }

      // 2. 聊天室消息
      if (msg.type === 'roomMessage') {
        const sql = 'INSERT INTO messages (roomName, fromUserId, content, isAdmin, timestamp) VALUES (?, ?, ?, ?, ?)';
        db.run(sql, [msg.roomName, msg.userId, msg.content, msg.isAdmin ? 1 : 0, getTime()], (err) => {
          if (err) console.error('保存消息失败:', err);
        });
        // 广播
        broadcastToRoom(msg.roomName, 'roomMessage', {
          fromUserId: msg.userId,
          nickname: msg.nickname,
          content: msg.content,
          isAdmin: msg.isAdmin,
          timestamp: getTime()
        });
        return;
      }

      // 3. 私聊消息
      if (msg.type === 'privateMessage') {
        const sql = 'INSERT INTO messages (fromUserId, toUserId, content, timestamp) VALUES (?, ?, ?, ?)';
        db.run(sql, [msg.fromUserId, msg.toUserId, msg.content, getTime()], (err) => {
          if (err) console.error('保存私聊失败:', err);
        });
        // 发给双方
        const pm = {
          type: 'privateMessage',
          data: {
            fromUserId: msg.fromUserId,
            fromNickname: msg.fromNickname,
            toUserId: msg.toUserId,
            content: msg.content,
            timestamp: getTime()
          }
        };
        ws.send(JSON.stringify(pm));
        broadcastToUser(msg.toUserId, 'privateMessage', pm.data);
        return;
      }

    } catch (e) {
      console.error('消息处理失败:', e);
    }
  });

  ws.on('close', () => {
    if (currentUser) {
      onlineUsers.delete(currentUser.userId);
    }
  });
});

server.listen(PORT, () => console.log(`服务运行在端口 ${PORT}`));
