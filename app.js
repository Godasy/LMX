const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

let onlineUsers = new Map();
const ADMIN_PASSWORD = 'Lmx%%112233';

// ==================== 关键修复1：Render 专属数据库路径 ====================
// Render 只有 /tmp 目录可写，且重启后不会丢（相对于项目根目录）
const dbPath = process.env.NODE_ENV === 'production' 
  ? path.join('/tmp', 'chat.db') 
  : path.join(__dirname, 'chat.db');

console.log('🚀 正在启动服务...');
console.log('📁 数据库路径:', dbPath);

// ==================== 关键修复2：数据库初始化加详细日志 ====================
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ 数据库连接失败:', err.message);
    process.exit(1); // 连接失败直接退出，避免假死
  } else {
    console.log('✅ 数据库连接成功');
    
    // 串行建表，避免竞态条件
    db.serialize(() => {
      console.log('📝 开始创建数据表...');
      
      // 1. 用户表
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        nickname TEXT NOT NULL,
        ip TEXT NOT NULL
      )`, (err) => {
        if (err) console.error('❌ 创建用户表失败:', err.message);
        else console.log('✅ 用户表就绪');
      });

      // 2. 好友表
      db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId1 TEXT NOT NULL,
        userId2 TEXT NOT NULL,
        status INTEGER DEFAULT 0,
        createTime DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) console.error('❌ 创建好友表失败:', err.message);
        else console.log('✅ 好友表就绪');
      });

      // 3. 聊天室表
      db.run(`CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roomName TEXT UNIQUE NOT NULL,
        createTime DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) console.error('❌ 创建聊天室表失败:', err.message);
        else console.log('✅ 聊天室表就绪');
      });

      // 4. 消息表
      db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roomName TEXT,
        fromUserId TEXT,
        toUserId TEXT,
        content TEXT,
        isAdmin INTEGER DEFAULT 0,
        isNotice INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) console.error('❌ 创建消息表失败:', err.message);
        else console.log('✅ 消息表就绪');
      });

      // 5. 初始化默认聊天室
      db.run('INSERT OR IGNORE INTO rooms (roomName) VALUES (?)', ['公共聊天室'], (err) => {
        if (err) console.error('❌ 初始化默认聊天室失败:', err.message);
        else console.log('✅ 默认聊天室就绪');
        
        // 所有表建完后，再启动 HTTP 服务
        startServer();
      });
    });
  }
});

// 工具函数
function getClientIP(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.connection.remoteAddress || '').replace(/[^0-9a-fA-F:\.]/g, '');
}
function getTime() {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}
function broadcastToRoom(roomName, type, data, wss) {
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

// ==================== API 接口（和之前一样，不用改）====================
app.get('/api/rooms', (req, res) => {
  db.all('SELECT * FROM rooms ORDER BY createTime DESC', (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/register', (req, res) => {
  const { userId, password, nickname } = req.body;
  const ip = getClientIP(req);
  if (!userId || !password || !nickname) return res.status(400).json({ success: false, message: '信息不完整' });

  db.get('SELECT * FROM users WHERE ip = ?', [ip], (err, row) => {
    if (row) return res.status(400).json({ success: false, message: '该IP已注册过账号' });
    db.get('SELECT * FROM users WHERE userId = ?', [userId], (err, row) => {
      if (row) return res.status(400).json({ success: false, message: 'ID已被使用' });
      db.run('INSERT INTO users (userId, password, nickname, ip) VALUES (?, ?, ?, ?)', 
        [userId, password, nickname, ip], (err) => {
          if (err) return res.status(500).json({ success: false, message: '注册失败' });
          res.json({ success: true, message: '注册成功' });
        });
    });
  });
});

app.post('/api/login', (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) return res.status(400).json({ success: false, message: '信息不完整' });
  db.get('SELECT * FROM users WHERE userId = ? AND password = ?', [userId, password], (err, row) => {
    if (!row) return res.status(401).json({ success: false, message: 'ID或密码错误' });
    res.json({ success: true, user: { userId: row.userId, nickname: row.nickname } });
  });
});

app.get('/api/friends/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `SELECT u.userId, u.nickname FROM friends f JOIN users u ON (f.userId1 = u.userId OR f.userId2 = u.userId) WHERE (f.userId1 = ? OR f.userId2 = ?) AND f.status = 1 AND u.userId != ?`;
  db.all(sql, [userId, userId, userId], (err, rows) => res.json(rows || []));
});

app.get('/api/friend-requests/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `SELECT f.id, u.userId as fromUserId, u.nickname as fromNickname FROM friends f JOIN users u ON f.userId1 = u.userId WHERE f.userId2 = ? AND f.status = 0`;
  db.all(sql, [userId], (err, rows) => res.json(rows || []));
});

app.post('/api/add-friend', (req, res) => {
  const { fromUserId, toUserId } = req.body;
  if (!fromUserId || !toUserId) return res.status(400).json({ success: false });
  const checkSql = 'SELECT * FROM friends WHERE (userId1 = ? AND userId2 = ?) OR (userId1 = ? AND userId2 = ?)';
  db.get(checkSql, [fromUserId, toUserId, toUserId, fromUserId], (err, row) => {
    if (row) return res.status(400).json({ success: false, message: '已是好友或已申请' });
    db.run('INSERT INTO friends (userId1, userId2, status) VALUES (?, ?, 0)', [fromUserId, toUserId], (err) => {
      if (err) return res.status(500).json({ success: false });
      broadcastToUser(toUserId, 'friendRequest', { fromUserId, fromNickname: fromUserId });
      res.json({ success: true });
    });
  });
});

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

app.post('/api/delete-friend', (req, res) => {
  const { userId1, userId2 } = req.body;
  const sql = 'DELETE FROM friends WHERE (userId1 = ? AND userId2 = ?) OR (userId1 = ? AND userId2 = ?)';
  db.run(sql, [userId1, userId2, userId2, userId1], (err) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true });
  });
});

app.get('/api/messages', (req, res) => {
  const { roomName, userId1, userId2 } = req.query;
  let sql, params;
  if (roomName) {
    sql = 'SELECT * FROM messages WHERE roomName = ? ORDER BY timestamp ASC';
    params = [roomName];
  } else if (userId1 && userId2) {
    sql = 'SELECT * FROM messages WHERE (fromUserId = ? AND toUserId = ?) OR (fromUserId = ? AND toUserId = ?) ORDER BY timestamp ASC';
    params = [userId1, userId2, userId2, userId1];
  } else {
    return res.status(400).json({ error: '参数错误' });
  }
  db.all(sql, params, (err, rows) => res.json(rows || []));
});

app.get('/api/notices', (req, res) => {
  db.all('SELECT * FROM messages WHERE isNotice = 1 ORDER BY timestamp DESC LIMIT 10', (err, rows) => res.json(rows || []));
});

// 管理员 API
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
    onlineUsers.forEach((user) => {
      if (user.ws.readyState === WebSocket.OPEN) {
        user.ws.send(JSON.stringify({ type: 'notice', data: { content, timestamp: getTime() } }));
      }
    });
    res.json({ success: true });
  });
});

// ==================== 关键修复3：启动服务的函数 ====================
function startServer() {
  console.log('🚀 所有数据表准备完毕，正在启动 HTTP/WebSocket 服务...');
  
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  // WebSocket 逻辑
  wss.on('connection', (ws) => {
    let currentUser = null;
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'joinRoom') {
          currentUser = { ws, userId: msg.userId, nickname: msg.nickname, currentRoom: msg.roomName };
          onlineUsers.set(msg.userId, currentUser);
          db.all('SELECT * FROM messages WHERE roomName = ? ORDER BY timestamp ASC', [msg.roomName], (err, rows) => {
            ws.send(JSON.stringify({ type: 'historyMessages', data: rows }));
          });
          return;
        }
        if (msg.type === 'roomMessage') {
          const sql = 'INSERT INTO messages (roomName, fromUserId, content, isAdmin, timestamp) VALUES (?, ?, ?, ?, ?)';
          db.run(sql, [msg.roomName, msg.userId, msg.content, msg.isAdmin ? 1 : 0, getTime()], (err) => {
            if (err) console.error('保存消息失败:', err);
          });
          broadcastToRoom(msg.roomName, 'roomMessage', {
            roomName: msg.roomName,
            fromUserId: msg.userId,
            nickname: msg.nickname,
            content: msg.content,
            isAdmin: msg.isAdmin,
            timestamp: getTime()
          }, wss);
          return;
        }
        if (msg.type === 'privateMessage') {
          const sql = 'INSERT INTO messages (fromUserId, toUserId, content, timestamp) VALUES (?, ?, ?, ?)';
          db.run(sql, [msg.fromUserId, msg.toUserId, msg.content, getTime()], (err) => {
            if (err) console.error('保存私聊失败:', err);
          });
          const pm = { type: 'privateMessage', data: {
            fromUserId: msg.fromUserId, fromNickname: msg.fromNickname,
            toUserId: msg.toUserId, content: msg.content, timestamp: getTime()
          }};
          ws.send(JSON.stringify(pm));
          broadcastToUser(msg.toUserId, 'privateMessage', pm.data);
          return;
        }
      } catch (e) { console.error('消息处理失败:', e); }
    });
    ws.on('close', () => { if (currentUser) onlineUsers.delete(currentUser.userId); });
  });

  // ==================== 关键修复4：强制监听 0.0.0.0 ====================
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🎉 ================================== 🎉');
    console.log('✅ 服务启动成功！');
    console.log(`🌐 监听地址: 0.0.0.0:${PORT}`);
    console.log(`🔗 访问地址: http://localhost:${PORT}`);
    console.log('🎉 ================================== 🎉');
    console.log('');
  });

  // 全局错误捕获
  server.on('error', (err) => {
    console.error('❌ 服务启动失败:', err.message);
    process.exit(1);
  });
}
