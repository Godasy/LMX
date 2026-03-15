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

// ===== 全局状态管理 =====
// 在线用户列表 { ws: WebSocket, ip: string, username: string, isMuted: boolean }
let onlineUsers = [];
// 禁言IP列表（持久化到数据库）
let mutedIPs = [];
// 管理员密码
const ADMIN_PASSWORD = 'Lmx%%112233';

// ===== Q3(SQLite) 数据库配置（永久存储）=====
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接 Q3(SQLite) 数据库');
    // 1. 创建消息表
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      isAdmin BOOLEAN DEFAULT 0,
      isNotice BOOLEAN DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip TEXT
    )`);
    // 2. 创建禁言IP表
    db.run(`CREATE TABLE IF NOT EXISTS muted_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT UNIQUE NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // 3. 加载禁言IP列表
    db.all('SELECT ip FROM muted_ips', (err, rows) => {
      if (!err) mutedIPs = rows.map(row => row.ip);
    });
  }
});

// ===== 工具函数 =====
// 获取客户端IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress || 
         req.connection.socket.remoteAddress;
}

// 广播系统消息（在线人数/公告）
function broadcastSystemMessage(type, data) {
  const message = JSON.stringify({
    type,
    data,
    timestamp: new Date().toLocaleString()
  });
  onlineUsers.forEach(user => {
    if (user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(message);
    }
  });
}

// 更新并广播在线人数
function updateOnlineCount() {
  const count = onlineUsers.filter(user => !user.isMuted).length;
  broadcastSystemMessage('onlineCount', count);
}

// ===== API 接口 =====
// 1. 获取历史消息
app.get('/api/messages', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY timestamp ASC', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// 2. 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin_' + Date.now() }); // 简易token
  } else {
    res.status(401).json({ success: false, message: '密码错误' });
  }
});

// 3. 获取在线用户列表（管理员）
app.get('/api/admin/online-users', (req, res) => {
  const users = onlineUsers.map(user => ({
    ip: user.ip,
    username: user.username || '未命名',
    isMuted: user.isMuted
  }));
  res.json(users);
});

// 4. 禁言/解除禁言IP
app.post('/api/admin/mute-ip', (req, res) => {
  const { ip, mute } = req.body;
  if (!ip) return res.status(400).json({ success: false, message: 'IP不能为空' });

  if (mute) {
    // 禁言：添加到数据库和内存
    db.run('INSERT OR IGNORE INTO muted_ips (ip) VALUES (?)', [ip], (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      mutedIPs.push(ip);
      // 断开该IP的连接
      onlineUsers.forEach(user => {
        if (user.ip === ip) {
          user.isMuted = true;
          user.ws.send(JSON.stringify({ type: 'muted', message: '你已被管理员禁言' }));
          user.ws.close();
        }
      });
      res.json({ success: true, message: '禁言成功' });
      updateOnlineCount();
    });
  } else {
    // 解除禁言：从数据库和内存删除
    db.run('DELETE FROM muted_ips WHERE ip = ?', [ip], (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      mutedIPs = mutedIPs.filter(item => item !== ip);
      res.json({ success: true, message: '解除禁言成功' });
    });
  }
});

// 5. 发送公告（管理员）
app.post('/api/admin/notice', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ success: false, message: '公告内容不能为空' });

  // 保存公告到数据库
  db.run(
    'INSERT INTO messages (username, content, isAdmin, isNotice, ip) VALUES (?, ?, 1, 1, ?)',
    ['系统公告', content, 'admin'],
    (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      
      // 广播公告
      broadcastSystemMessage('notice', {
        username: '系统公告',
        content,
        timestamp: new Date().toLocaleString()
      });
      res.json({ success: true, message: '公告发送成功' });
    }
  );
});

// 6. 保活接口（自动唤醒Render）
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'alive', time: new Date(), onlineCount: onlineUsers.length });
});

// ===== WebSocket 实时聊天 =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 监听WebSocket连接
wss.on('connection', (ws, req) => {
  const clientIP = getClientIP(req);
  console.log(`新用户连接，IP: ${clientIP}`);

  // 检查是否被禁言
  const isMuted = mutedIPs.includes(clientIP);
  if (isMuted) {
    ws.send(JSON.stringify({ type: 'muted', message: '你已被管理员禁言' }));
    ws.close();
    return;
  }

  // 添加到在线用户列表
  const user = { ws, ip: clientIP, username: '', isMuted: false };
  onlineUsers.push(user);
  updateOnlineCount();

  // 接收前端消息
  ws.on('message', (data) => {
    try {
      const { username, content, isAdmin } = JSON.parse(data);
      if (!username || !content) return;

      // 更新用户昵称
      user.username = username;

      // 检查是否被禁言
      if (user.isMuted) {
        ws.send(JSON.stringify({ type: 'error', message: '你已被禁言，无法发送消息' }));
        return;
      }

      // 保存消息到数据库
      const messageData = {
        username,
        content,
        isAdmin: isAdmin ? 1 : 0,
        ip: clientIP
      };

      db.run(
        'INSERT INTO messages (username, content, isAdmin, ip) VALUES (?, ?, ?, ?)',
        [messageData.username, messageData.content, messageData.isAdmin, messageData.ip],
        (err) => {
          if (err) console.error('保存消息失败:', err);
        }
      );

      // 广播消息给所有在线用户
      const broadcastMsg = JSON.stringify({
        type: 'chat',
        data: {
          username: messageData.username,
          content: messageData.content,
          isAdmin: messageData.isAdmin,
          timestamp: new Date().toLocaleString()
        }
      });

      onlineUsers.forEach(u => {
        if (u.ws.readyState === WebSocket.OPEN) {
          u.ws.send(broadcastMsg);
        }
      });
    } catch (err) {
      console.error('解析消息失败:', err);
    }
  });

  // 断开连接
  ws.on('close', () => {
    console.log(`用户断开连接，IP: ${clientIP}`);
    // 从在线列表移除
    onlineUsers = onlineUsers.filter(u => u.ws !== ws);
    updateOnlineCount();
  });

  // 错误处理
  ws.onerror = (err) => {
    console.error(`WebSocket错误，IP: ${clientIP}`, err);
    onlineUsers = onlineUsers.filter(u => u.ws !== ws);
    updateOnlineCount();
  };
});

// 启动服务
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`后端服务运行在端口 ${PORT}`);
});