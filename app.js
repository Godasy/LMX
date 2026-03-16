const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'Lmx%%112233';

let onlineUsers = [];
let chatRooms = [{ id: 'default', name: '默认聊天室', desc: '所有人可进入的公共聊天室' }];

// 数据库初始化
const db = new sqlite3.Database(path.join(__dirname, 'chat.db'), (err) => {
  if (err) console.error('数据库连接失败:', err.message);
  else {
    console.log('成功连接SQLite数据库');
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      pwd TEXT NOT NULL,
      name TEXT NOT NULL,
      ip TEXT UNIQUE NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
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
});

// 工具函数
const getClientIP = (req) => (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].replace(/::ffff:/, '');
const broadcastToAll = (msg) => wss.clients.forEach(client => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(msg)));

// API: 用户注册 (ID唯一)
app.post('/api/register', (req, res) => {
  const { id, pwd, name } = req.body;
  const ip = getClientIP(req);
  db.get('SELECT id FROM users WHERE id = ?', [id], (err, row) => {
    if (row) return res.json({ success: false, message: 'ID已被占用，请更换' });
    db.run('INSERT INTO users (id, pwd, name, ip) VALUES (?, ?, ?, ?)', [id, pwd, name, ip], (err) => {
      err ? res.json({ success: false, message: '注册失败' }) : res.json({ success: true, user: { id, name, ip } });
    });
  });
});

// API: 用户登录 (验证ID密码)
app.post('/api/login', (req, res) => {
  const { id, pwd } = req.body;
  const ip = getClientIP(req);
  db.get('SELECT id, name, ip FROM users WHERE id = ? AND pwd = ?', [id, pwd], (err, row) => {
    if (!row) return res.json({ success: false, message: 'ID或密码错误' });
    // 可在此处更新IP，实现多设备同账号踢下线逻辑
    res.json({ success: true, user: row });
  });
});

// API: 注销账号 (释放ID)
app.post('/api/logout', (req, res) => {
  const { id } = req.body;
  db.run('DELETE FROM users WHERE id = ?', [id], (err) => {
    err ? res.json({ success: false }) : res.json({ success: true, message: '账号已注销，ID已释放' });
  });
});

// API: 获取好友列表
app.get('/api/friends/:userId', (req, res) => {
  const { userId } = req.params;
  db.all(`
    SELECT u.id, u.name FROM friends f 
    JOIN users u ON f.friend_id = u.id 
    WHERE f.user_id = ?
  `, [userId], (err, rows) => {
    res.json({ success: true, friends: rows });
  });
});

// API: 发送好友申请
app.post('/api/friend-apply', (req, res) => {
  const { fromId, toId } = req.body;
  if (fromId === toId) return res.json({ success: false, message: '不能添加自己' });
  db.get('SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', [fromId, toId], (err, row) => {
    if (row) return res.json({ success: false, message: '已是好友' });
    db.run('INSERT INTO friend_applies (from_id, to_id) VALUES (?, ?)', [fromId, toId], (err) => {
      err ? res.json({ success: false }) : res.json({ success: true });
    });
  });
});

// 其他API (聊天室、消息、公告等) 保持与前版一致，此处省略以精简，完整代码见下文链接

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  ws.on('message', (data) => {
    // WebSocket消息处理逻辑，与前版一致
  });
});

server.listen(PORT, () => console.log(`服务器运行在端口 ${PORT}`));
