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
let privateChatMap = new Map();

// ===== Q3(SQLite) 数据库配置（修复SQL语法错误）=====
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接 Q3(SQLite) 数据库');
    // 1. 创建消息表（修复字段定义语法，移除非法字符）
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      isAdmin INTEGER DEFAULT 0,
      isNotice INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip TEXT,
      isPrivate INTEGER DEFAULT 0,
      privateTarget TEXT DEFAULT ''
    )`, (err) => { // 新增回调，捕获建表错误
      if (err) console.error('创建消息表失败:', err.message);
    });

    // 2. 创建禁言IP表
    db.run(`CREATE TABLE IF NOT EXISTS muted_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT UNIQUE NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建禁言表失败:', err.message);
    });

    // 加载禁言IP列表
    db.all('SELECT ip FROM muted_ips', (err, rows) => {
      if (!err) {
        mutedIPs = rows.map(row => row.ip);
        console.log('加载禁言IP:', mutedIPs);
      } else {
        console.error('加载禁言IP失败:', err.message);
      }
    });
  }
});

// ===== 工具函数 =====
function getClientIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress || 
         req.connection.socket.remoteAddress;
  // 清理IP中的非法字符（防止SQL注入/语法错误）
  return ip ? ip.replace(/[^0-9a-fA-F:\.]/g, '') : '';
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

function findUserByIP(ip) {
  return onlineUsers.find(user => user.ip === ip);
}

// ===== API 接口（修复SQL语句）=====
// 1. 删除单条消息（管理员）
app.post('/api/admin/delete-message', (req, res) => {
  const { messageId } = req.body;
  // 验证参数（防止非法字符）
  if (!messageId || isNaN(Number(messageId))) {
    return res.status(400).json({ success: false, message: '消息ID必须为数字' });
  }

  const sql = 'DELETE FROM messages WHERE id = ?';
  db.run(sql, [Number(messageId)], function(err) {
    if (err) {
      console.error('删除消息失败:', err.message);
      return res.status(500).json({ success: false, message: '删除失败：' + err.message });
    }
    // 检查是否真的删除了记录
    if (this.changes === 0) {
      return res.status(404).json({ success: false, message: '消息ID不存在' });
    }
    broadcastSystemMessage('messageDeleted', { id: messageId });
    res.json({ success: true, message: '消息删除成功' });
  });
});

// 2. 清空所有聊天记录（管理员）
app.post('/api/admin/clear-messages', (req, res) => {
  const sql = 'DELETE FROM messages WHERE isNotice = 0 AND isPrivate = 0';
  db.run(sql, function(err) {
    if (err) {
      console.error('清空记录失败:', err.message);
      return res.status(500).json({ success: false, message: '清空失败：' + err.message });
    }
    broadcastSystemMessage('messagesCleared', { time: new Date().toLocaleString() });
    res.json({ success: true, message: `成功清空 ${this.changes} 条普通聊天记录` });
  });
});

// 3. 删除指定公告（管理员）
app.post('/api/admin/delete-notice', (req, res) => {
  const { noticeId } = req.body;
  if (!noticeId || isNaN(Number(noticeId))) {
    return res.status(400).json({ success: false, message: '公告ID必须为数字' });
  }

  const sql = 'DELETE FROM messages WHERE id = ? AND isNotice = 1';
  db.run(sql, [Number(noticeId)], function(err) {
    if (err) {
      console.error('删除公告失败:', err.message);
      return res.status(500).json({ success: false, message: '删除失败：' + err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ success: false, message: '公告ID不存在' });
    }
    broadcastSystemMessage('noticeDeleted', { id: noticeId });
    res.json({ success: true, message: '公告删除成功' });
  });
});

// 4. 获取历史消息
app.get('/api/messages', (req, res) => {
  const sql = 'SELECT * FROM messages ORDER BY timestamp ASC';
  db.all(sql, (err, rows) => {
    if (err) {
      console.error('获取消息失败:', err.message);
      res.status(500).json({ error: '获取消息失败：' + err.message });
      return;
    }
    res.json(rows);
  });
});

// 5. 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin_' + Date.now() });
  } else {
    res.status(401).json({ success: false, message: '密码错误' });
  }
});

// 6. 获取在线用户列表（管理员）
app.get('/api/admin/online-users', (req, res) => {
  const users = onlineUsers.map(user => ({
    ip: user.ip,
    username: user.username || '未命名',
    isMuted: user.isMuted
  }));
  res.json(users);
});

// 7. 禁言/解除禁言IP
app.post('/api/admin/mute-ip', (req, res) => {
  const { ip, mute } = req.body;
  if (!ip) return res.status(400).json({ success: false, message: 'IP不能为空' });

  if (mute) {
    // 禁言：添加到数据库和内存
    const sql = 'INSERT OR IGNORE INTO muted_ips (ip) VALUES (?)';
    db.run(sql, [ip], (err) => {
      if (err) {
        console.error('禁言IP失败:', err.message);
        return res.status(500).json({ success: false, message: err.message });
      }
      if (!mutedIPs.includes(ip)) mutedIPs.push(ip);
      // 断开该IP的连接
      onlineUsers.forEach(user => {
        if (user.ip === ip) {
          user.isMuted = true;
          user.ws.send(JSON.stringify({ type: 'muted', message: '你已被管理员禁言' }));
          user.ws.close();
        }
      });
      updateOnlineCount();
      res.json({ success: true, message: '禁言成功' });
    });
  } else {
    // 解除禁言：从数据库和内存删除
    const sql = 'DELETE FROM muted_ips WHERE ip = ?';
    db.run(sql, [ip], (err) => {
      if (err) {
        console.error('解除禁言失败:', err.message);
        return res.status(500).json({ success: false, message: err.message });
      }
      mutedIPs = mutedIPs.filter(item => item !== ip);
      res.json({ success: true, message: '解除禁言成功' });
    });
  }
});

// 8. 发送公告（管理员）
app.post('/api/admin/notice', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ success: false, message: '公告内容不能为空' });

  const sql = 'INSERT INTO messages (username, content, isAdmin, isNotice, ip) VALUES (?, ?, 1, 1, ?)';
  db.run(sql, ['系统公告', content, 'admin'], (err) => {
    if (err) {
      console.error('保存公告失败:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
    
    // 广播公告
    broadcastSystemMessage('notice', {
      username: '系统公告',
      content,
      timestamp: new Date().toLocaleString()
    });
    res.json({ success: true, message: '公告发送成功' });
  });
});

// 9. 保活接口
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'alive', 
    time: new Date(), 
    onlineCount: onlineUsers.length,
    mutedIPs: mutedIPs 
  });
});

// ===== WebSocket 逻辑（修复参数处理）=====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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
      const msgData = JSON.parse(data);
      // 验证并清理参数（防止非法字符）
      const username = (msgData.username || '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '');
      const content = (msgData.content || '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\s,.?!，。？！]/g, '');
      const isAdmin = !!msgData.isAdmin;
      const isPrivate = !!msgData.isPrivate;
      const targetIP = (msgData.targetIP || '').replace(/[^0-9a-fA-F:\.]/g, '');

      if (!username || !content) return;
      user.username = username;

      // 检查是否被禁言
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
        const sql = 'INSERT INTO messages (username, content, isAdmin, isPrivate, privateTarget, ip) VALUES (?, ?, ?, 1, ?, ?)';
        db.run(sql, [username, content, isAdmin ? 1 : 0, targetIP, clientIP], (err) => {
          if (err) console.error('保存私聊消息失败:', err.message);
        });

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

      // ===== 普通消息逻辑 =====
      const sql = 'INSERT INTO messages (username, content, isAdmin, ip) VALUES (?, ?, ?, ?)';
      db.run(sql, [username, content, isAdmin ? 1 : 0, clientIP], (err) => {
        if (err) console.error('保存消息失败:', err.message);
      });

      const broadcastMsg = JSON.stringify({
        type: 'chat',
        data: {
          username,
          content,
          isAdmin,
          timestamp: new Date().toLocaleString()
        }
      });

      onlineUsers.forEach(u => {
        if (u.ws.readyState === WebSocket.OPEN) {
          u.ws.send(broadcastMsg);
        }
      });
    } catch (err) {
      console.error('解析消息失败:', err.message);
      ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
    }
  });

  // 断开连接
  ws.on('close', () => {
    console.log(`用户断开连接，IP: ${user.ip}`);
    onlineUsers = onlineUsers.filter(u => u.ws !== ws);
    privateChatMap.delete(user.ip);
    updateOnlineCount();
  });

  // 错误处理
  ws.onerror = (err) => {
    console.error(`WebSocket错误，IP: ${user.ip}`, err.message);
    onlineUsers = onlineUsers.filter(u => u.ws !== ws);
    privateChatMap.delete(user.ip);
    updateOnlineCount();
  };
});

// 启动服务
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`后端服务运行在端口 ${PORT}`);
});
