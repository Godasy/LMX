const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

// 初始化应用
const app = express();
app.use(cors()); // 允许跨域（适配InfinityFree前端）
app.use(express.json());

// ===== Q3(SQLite) 数据库配置（永久存储）=====
// 数据库文件路径（Render 中 /opt/render/project/src 目录可持久化）
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接 Q3(SQLite) 数据库');
    // 创建聊天记录表（不存在则创建，保证数据永久）
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// ===== API 接口（供前端获取历史消息）=====
// 获取所有历史消息
app.get('/api/messages', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY timestamp ASC', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// ===== WebSocket 实时聊天 =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 监听WebSocket连接
wss.on('connection', (ws) => {
  console.log('新用户连接');

  // 接收前端消息
  ws.on('message', (data) => {
    const { username, content } = JSON.parse(data);
    if (!username || !content) return;

    // 1. 保存消息到Q3数据库（永久存储）
    db.run(
      'INSERT INTO messages (username, content) VALUES (?, ?)',
      [username, content],
      (err) => {
        if (err) console.error('保存消息失败:', err);
      }
    );

    // 2. 广播消息给所有在线用户
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          username,
          content,
          timestamp: new Date().toLocaleString()
        }));
      }
    });
  });

  // 断开连接
  ws.on('close', () => {
    console.log('用户断开连接');
  });
});

// ===== 保活接口（用于自动唤醒Render）=====
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'alive', time: new Date() });
});

// 启动服务
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`后端服务运行在端口 ${PORT}`);
});