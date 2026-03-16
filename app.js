const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 1. 初始化 SQLite 数据库
const db = new sqlite3.Database('./chat.db');
db.serialize(() => {
  // 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nickname TEXT,
    password TEXT,
    is_online INTEGER DEFAULT 0
  )`);
  // 聊天室表
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    creator_id TEXT
  )`);
  // 消息表（聊天室/私聊）
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER,
    from_user TEXT,
    to_user TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_private INTEGER DEFAULT 0
  )`);
  // 好友表
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    user_id TEXT,
    friend_id TEXT,
    status INTEGER DEFAULT 0,  // 0: 申请中, 1: 已同意
    PRIMARY KEY (user_id, friend_id)
  )`);
  // 公告表
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // 插入默认聊天室
  db.run(`INSERT OR IGNORE INTO rooms (name) VALUES ('默认聊天室')`);
});

// 2. 中间件
app.use(express.json());
app.use((req, res, next) => {
  // 简单的 JWT 验证逻辑（需完善）
  const token = req.headers['authorization'];
  if (token) {
    jwt.verify(token, 'your-secret-key', (err, decoded) => {
      if (!err) req.user = decoded;
    });
  }
  next();
});

// 3. API 路由示例（需完善注册、登录、好友、管理员等接口）
app.post('/register', (req, res) => {
  const { id, nickname, password } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 8);
  db.run(`INSERT INTO users (id, nickname, password) VALUES (?, ?, ?)`,
    [id, nickname, hashedPassword], (err) => {
      if (err) return res.status(400).json({ error: 'ID已存在' });
      res.json({ message: '注册成功' });
    });
});

// 4. WebSocket 实时通信（需完善消息转发、在线状态同步等）
wss.on('connection', (ws, req) => {
  // 验证用户身份后处理消息
  ws.on('message', (data) => {
    const message = JSON.parse(data);
    // 广播消息到对应聊天室/私聊用户
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));
