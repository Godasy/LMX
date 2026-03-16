const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

// 强制使用异步模式 + 非阻塞初始化
const app = express();
app.use(cors()); // 全局跨域
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. 优化 SQLite 配置：异步模式 + 非阻塞初始化
const db = new sqlite3.Database('./chat.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
    // 即使数据库失败，也不阻塞服务启动
    startServer();
  } else {
    console.log('✅ 连接到 SQLite 数据库');
    // 异步创建表，不阻塞启动
    initDatabase().then(() => {
      console.log('✅ 数据库表初始化完成');
      startServer();
    }).catch(err => {
      console.error('表初始化失败:', err);
      startServer(); // 表创建失败仍启动服务
    });
  }
});

// 2. 异步初始化数据库表（非阻塞）
async function initDatabase() {
  return new Promise((resolve, reject) => {
    const createTables = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        pwd TEXT NOT NULL,
        name TEXT NOT NULL,
        create_time INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS chatrooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        create_time INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        username TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        is_red INTEGER DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        friend_id TEXT NOT NULL,
        friend_name TEXT NOT NULL,
        create_time INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS friend_applies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        to_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        create_time INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        create_time INTEGER NOT NULL
      )`
    ];

    // 串行执行建表语句（异步）
    let index = 0;
    function executeNext() {
      if (index >= createTables.length) {
        resolve();
        return;
      }
      db.run(createTables[index], (err) => {
        if (err) {
          reject(err);
          return;
        }
        index++;
        executeNext();
      });
    }
    executeNext();
  });
}

// 3. 启动服务器（核心：不阻塞，监听 0.0.0.0）
function startServer() {
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  // 全局状态
  const clients = new Map();
  const PORT = process.env.PORT || 3000;

  // WebSocket 处理（简化 + 非阻塞）
  wss.on('connection', (ws) => {
    let currentUser = null;
    console.log('🔌 新客户端连接');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg, currentUser);
      } catch (e) {
        console.error('消息解析失败:', e);
      }
    });

    ws.on('close', () => {
      if (currentUser) clients.delete(currentUser.id);
      console.log('🔌 客户端断开连接');
    });

    ws.on('error', (err) => {
      console.error('WS 错误:', err);
    });

    function handleMessage(ws, msg, user) {
      switch (msg.type) {
        case 'online':
          currentUser = { id: msg.userId, name: msg.userName };
          clients.set(msg.userId, ws);
          sendLatestNotice(ws);
          break;
        case 'chat':
          saveChatMessage(msg).then(() => {
            broadcastToRoom(msg.roomId, {
              type: 'chat',
              data: msg
            });
          });
          break;
        case 'privateChat':
          sendPrivateMessage(ws, msg);
          break;
        case 'friendApply':
          saveFriendApply(msg).then(() => {
            sendToUser(msg.toId, { type: 'friendApply', data: msg });
          });
          break;
        case 'friendAgree':
          saveFriendRelation(msg).then(() => {
            sendToUser(msg.toId, { type: 'friendAgree', data: { friend: { id: msg.fromId, name: msg.fromName } } });
          });
          break;
        default:
          console.log('未知消息类型:', msg.type);
      }
    }
  });

  // 4. API 路由（简化 + 异步）
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.get('/api/chatrooms', (req, res) => {
    db.all(`SELECT * FROM chatrooms`, (err, rows) => {
      res.json({ success: !err, rooms: rows || [] });
    });
  });

  app.get('/api/chatrooms/:id/messages', (req, res) => {
    db.all(`SELECT * FROM messages WHERE room_id = ? ORDER BY id ASC`, [req.params.id], (err, rows) => {
      res.json({ success: !err, messages: rows || [] });
    });
  });

  app.post('/api/delete-account', (req, res) => {
    const { id } = req.body;
    db.run(`DELETE FROM users WHERE id = ?`, [id], (err) => {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true });
    });
  });

  // 5. 启动 HTTP 服务（监听 0.0.0.0，关键！）
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务器启动成功！端口: ${PORT}`);
    console.log(`🌐 访问地址: http://0.0.0.0:${PORT}`);
  });

  // 工具函数（异步化）
  function broadcastToRoom(roomId, data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }

  function sendToUser(userId, data) {
    const ws = clients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function sendPrivateMessage(ws, msg) {
    const { from, to, content, timestamp } = msg;
    // 发给对方
    sendToUser(to.id, { type: 'privateChat', data: msg });
    // 发给自己
    ws.send(JSON.stringify({ type: 'privateChat', data: msg }));
  }

  function saveChatMessage(msg) {
    return new Promise((resolve) => {
      db.run(
        `INSERT INTO messages (room_id, username, content, timestamp, is_admin) VALUES (?, ?, ?, ?, ?)`,
        [msg.roomId, msg.username, msg.content, msg.timestamp, msg.isAdmin ? 1 : 0],
        resolve
      );
    });
  }

  function saveFriendApply(msg) {
    return new Promise((resolve) => {
      db.run(
        `INSERT INTO friend_applies (from_id, from_name, to_id, create_time) VALUES (?, ?, ?, ?)`,
        [msg.fromId, msg.fromName, msg.toId, Date.now()],
        resolve
      );
    });
  }

  function saveFriendRelation(msg) {
    return new Promise((resolve) => {
      db.run(`INSERT INTO friends (user_id, friend_id, friend_name, create_time) VALUES (?, ?, ?, ?)`,
        [msg.fromId, msg.toId, msg.fromName, Date.now()]);
      db.run(`INSERT INTO friends (user_id, friend_id, friend_name, create_time) VALUES (?, ?, ?, ?)`,
        [msg.toId, msg.fromId, msg.fromName, Date.now()]);
      resolve();
    });
  }

  function sendLatestNotice(ws) {
    db.get(`SELECT content FROM notices ORDER BY create_time DESC LIMIT 1`, (err, row) => {
      if (row) {
        ws.send(JSON.stringify({ type: 'notice', content: row.content }));
      }
    });
  }
}

// 兜底错误捕获（防止服务崩溃）
process.on('uncaughtException', (err) => {
  console.error('未捕获异常:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('未处理 Promise 拒绝:', err);
});
