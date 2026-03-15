const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

// 初始化应用
const app = express();
app.use(cors()); 
app.use(express.json());

// ===== 全局状态管理 =====
let onlineUsers = [];
let mutedIPs = [];
const ADMIN_PASSWORD = 'Lmx%%112233';
// 新增：私聊映射 { 私聊发起方IP: 私聊接收方IP, ... }
let privateChatMap = new Map();

// ===== Q3(SQLite) 数据库配置 =====
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接 Q3(SQLite) 数据库');
    // 1. 创建消息表（保留原有结构）
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      isAdmin BOOLEAN DEFAULT 0,
      isNotice BOOLEAN DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip TEXT,
      // 新增：私聊标识字段
      isPrivate BOOLEAN DEFAULT 0,
      privateTarget TEXT DEFAULT ''
    )`);
    // 2. 创建禁言IP表
    db.run(`CREATE TABLE IF NOT EXISTS muted_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT UNIQUE NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // 加载禁言IP列表
    db.all('SELECT ip FROM muted_ips', (err, rows) => {
      if (!err) mutedIPs = rows.map(row => row.ip);
    });
  }
});

// ===== 工具函数 =====
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress || 
         req.connection.socket.remoteAddress;
}

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

function updateOnlineCount() {
  const count = onlineUsers.filter(user => !user.isMuted).length;
  broadcastSystemMessage('onlineCount', count);
}

// 新增：根据IP查找在线用户的WS连接
function findUserByIP(ip) {
  return onlineUsers.find(user => user.ip === ip);
}

// ===== API 接口新增/修改 =====
// 1. 新增：删除单条消息（管理员）
app.post('/api/admin/delete-message', (req, res) => {
  const { messageId } = req.body;
  if (!messageId) {
    return res.status(400).json({ success: false, message: '消息ID不能为空' });
  }

  db.run('DELETE FROM messages WHERE id = ?', [messageId], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    // 广播消息删除通知
    broadcastSystemMessage('messageDeleted', { id: messageId });
    res.json({ success: true, message: '消息删除成功' });
  });
});

// 2. 新增：清空所有聊天记录（管理员）
app.post('/api/admin/clear-messages', (req, res) => {
  db.run('DELETE FROM messages WHERE isNotice = 0', (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    broadcastSystemMessage('messagesCleared', { time: new Date().toLocaleString() });
    res.json({ success: true, message: '普通聊天记录清空成功' });
  });
});

// 3. 新增：删除指定公告（管理员）
app.post('/api/admin/delete-notice', (req, res) => {
  const { noticeId } = req.body;
  if (!noticeId) {
    return res.status(400).json({ success: false, message: '公告ID不能为空' });
  }

  db.run('DELETE FROM messages WHERE id = ? AND isNotice = 1', [noticeId], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    broadcastSystemMessage('noticeDeleted', { id: noticeId });
    res.json({ success: true, message: '公告删除成功' });
  });
});

// 4. 原有接口：获取历史消息（新增私聊字段返回）
app.get('/api/messages', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY timestamp ASC', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// 其余原有接口（登录/禁言/公告/health）保留不变...

// ===== WebSocket 新增私聊逻辑 =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientIP = getClientIP(req);
  console.log(`新用户连接，IP: ${clientIP}`);

  // 检查禁言
  const isMuted = mutedIPs.includes(clientIP);
  if (isMuted) {
    ws.send(JSON.stringify({ type: 'muted', message: '你已被管理员禁言' }));
    ws.close();
    return;
  }

  // 添加到在线用户列表（新增username和私聊相关）
  const user = { ws, ip: clientIP, username: '', isMuted: false };
  onlineUsers.push(user);
  updateOnlineCount();

  // 接收前端消息
  ws.on('message', (data) => {
    try {
      const msgData = JSON.parse(data);
      const { username, content, isAdmin, isPrivate, targetIP } = msgData;

      if (!username || !content) return;
      user.username = username;

      // 禁言检查
      if (user.isMuted) {
        ws.send(JSON.stringify({ type: 'error', message: '你已被禁言，无法发送消息' }));
        return;
      }

      // ===== 私聊逻辑 =====
      if (isPrivate && targetIP) {
        const targetUser = findUserByIP(targetIP);
        if (!targetUser) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: '对方不在线或IP错误' 
          }));
          return;
        }

        // 保存私聊消息到数据库
        db.run(
          'INSERT INTO messages (username, content, isAdmin, isPrivate, privateTarget, ip) VALUES (?, ?, ?, 1, ?, ?)',
          [username, content, isAdmin ? 1 : 0, targetIP, clientIP],
          (err) => {
            if (err) console.error('保存私聊消息失败:', err);
          }
        );

        // 发送私聊消息给双方
        const privateMsg = JSON.stringify({
          type: 'privateChat',
          data: {
            from: { username, ip: clientIP },
            to: { username: targetUser.username || '未命名', ip: targetIP },
            content,
            timestamp: new Date().toLocaleString()
          }
        });

        // 发送给发起方
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(privateMsg);
        }
        // 发送给接收方
        if (targetUser.ws.readyState === WebSocket.OPEN) {
          targetUser.ws.send(privateMsg);
        }
        return;
      }

      // ===== 普通消息/管理员消息逻辑（原有）=====
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
    onlineUsers = onlineUsers.filter(u => u.ws !== ws);
    privateChatMap.delete(clientIP); // 清理私聊映射
    updateOnlineCount();
  });

  ws.onerror = (err) => {
    console.error(`WebSocket错误，IP: ${clientIP}`, err);
    onlineUsers = onlineUsers.filter(u => u.ws !== ws);
    privateChatMap.delete(clientIP);
    updateOnlineCount();
  };
});

// 启动服务
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`后端服务运行在端口 ${PORT}`);
});
