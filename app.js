const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

// 强制启用日志，便于排查
process.env.DEBUG = 'ws:*';

const app = express();
// 关键修复：允许所有跨域（包括WS）
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

// 全局状态初始化
let onlineUsers = [];
let mutedIPs = [];
const ADMIN_PASSWORD = 'Lmx%%112233';
let wss; // 全局WS实例

// ===== 数据库初始化（添加日志）=====
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
    return;
  }
  console.log('✅ 成功连接数据库');
  
  // 1. 创建消息表（确保字段兼容）
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    isAdmin INTEGER DEFAULT 0,
    isNotice INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip TEXT,
    isPrivate INTEGER DEFAULT 0,
    privateTarget TEXT DEFAULT '',
    isImage INTEGER DEFAULT 0
  )`, (err) => {
    if (err) console.error('创建消息表失败:', err.message);
    else console.log('✅ 消息表初始化完成');
  });

  // 2. 创建禁言IP表
  db.run(`CREATE TABLE IF NOT EXISTS muted_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT UNIQUE NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('创建禁言表失败:', err.message);
    else console.log('✅ 禁言表初始化完成');
  });

  // 加载禁言IP
  db.all('SELECT ip FROM muted_ips', (err, rows) => {
    if (!err) {
      mutedIPs = rows.map(row => row.ip);
      console.log('✅ 加载禁言IP:', mutedIPs);
    } else {
      console.error('加载禁言IP失败:', err.message);
    }
  });
});

// ===== 工具函数 =====
function getClientIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress || 
         req.connection.socket.remoteAddress || '';
  // 清理IP格式（兼容IPv6）
  return ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
}

function broadcastSystemMessage(type, data) {
  const message = JSON.stringify({
    type,
    data,
    timestamp: new Date().toLocaleString()
  });
  if (!wss) return;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function updateOnlineCount() {
  const count = onlineUsers.filter(user => !user.isMuted).length;
  broadcastSystemMessage('onlineCount', count);
  console.log(`📢 在线人数更新: ${count}`);
}

function findUserByIP(ip) {
  return onlineUsers.find(user => user.ip === ip);
}

// ===== API 接口（全部添加日志）=====
app.get('/api/messages', (req, res) => {
  console.log('🔍 获取历史消息请求');
  db.all('SELECT * FROM messages ORDER BY timestamp ASC', (err, rows) => {
    if (err) {
      console.error('获取消息失败:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

app.post('/api/admin/login', (req, res) => {
  console.log('🔑 管理员登录请求');
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin_' + Date.now() });
  } else {
    res.status(401).json({ success: false, message: '密码错误' });
  }
});

app.get('/api/admin/online-users', (req, res) => {
  console.log('👥 获取在线用户请求');
  const users = onlineUsers.map(user => ({
    ip: user.ip,
    username: user.username || '未命名',
    isMuted: user.isMuted
  }));
  res.json(users);
});

app.post('/api/admin/mute-ip', (req, res) => {
  const { ip, mute } = req.body;
  console.log(`🚫 禁言操作: ${ip} - ${mute ? '禁言' : '解除禁言'}`);
  if (!ip) {
    return res.status(400).json({ success: false, message: 'IP不能为空' });
  }

  if (mute) {
    db.run('INSERT OR IGNORE INTO muted_ips (ip) VALUES (?)', [ip], (err) => {
      if (err) {
        console.error('禁言IP失败:', err.message);
        return res.status(500).json({ success: false, message: err.message });
      }
      if (!mutedIPs.includes(ip)) mutedIPs.push(ip);
      // 断开该IP连接
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
    db.run('DELETE FROM muted_ips WHERE ip = ?', [ip], (err) => {
      if (err) {
        console.error('解除禁言失败:', err.message);
        return res.status(500).json({ success: false, message: err.message });
      }
      mutedIPs = mutedIPs.filter(item => item !== ip);
      res.json({ success: true, message: '解除禁言成功' });
    });
  }
});

app.post('/api/admin/notice', (req, res) => {
  const { content } = req.body;
  console.log(`📢 发送公告: ${content}`);
  if (!content) {
    return res.status(400).json({ success: false, message: '公告内容不能为空' });
  }

  db.run(
    'INSERT INTO messages (username, content, isAdmin, isNotice, ip) VALUES (?, ?, 1, 1, ?)',
    ['系统公告', content, 'admin'],
    (err) => {
      if (err) {
        console.error('保存公告失败:', err.message);
        return res.status(500).json({ success: false, message: err.message });
      }
      broadcastSystemMessage('notice', {
        username: '系统公告',
        content: content,
        timestamp: new Date().toLocaleString()
      });
      res.json({ success: true, message: '公告发送成功' });
    }
  );
});

app.post('/api/admin/delete-message', (req, res) => {
  const { messageId } = req.body;
  console.log(`🗑️ 删除消息: ID=${messageId}`);
  if (!messageId || isNaN(Number(messageId))) {
    return res.status(400).json({ success: false, message: '消息ID必须为数字' });
  }

  db.run('DELETE FROM messages WHERE id = ?', [Number(messageId)], function (err) {
    if (err) {
      console.error('删除消息失败:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ success: false, message: '消息ID不存在' });
    }
    broadcastSystemMessage('messageDeleted', { id: messageId });
    res.json({ success: true, message: '消息删除成功' });
  });
});

app.post('/api/admin/clear-messages', (req, res) => {
  console.log('🗑️ 清空所有普通聊天记录');
  db.run('DELETE FROM messages WHERE isNotice = 0 AND isPrivate = 0', function (err) {
    if (err) {
      console.error('清空记录失败:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
    broadcastSystemMessage('messagesCleared', { time: new Date().toLocaleString() });
    res.json({ success: true, message: `成功清空 ${this.changes} 条记录` });
  });
});

app.post('/api/admin/delete-notice', (req, res) => {
  const { noticeId } = req.body;
  console.log(`🗑️ 删除公告: ID=${noticeId}`);
  if (!noticeId || isNaN(Number(noticeId))) {
    return res.status(400).json({ success: false, message: '公告ID必须为数字' });
  }

  db.run('DELETE FROM messages WHERE id = ? AND isNotice = 1', [Number(noticeId)], function (err) {
    if (err) {
      console.error('删除公告失败:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ success: false, message: '公告ID不存在' });
    }
    broadcastSystemMessage('noticeDeleted', { id: noticeId });
    res.json({ success: true, message: '公告删除成功' });
  });
});

// 健康检查接口（关键：用于验证服务是否启动）
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'alive',
    time: new Date(),
    onlineCount: onlineUsers.length,
    mutedIPs: mutedIPs,
    wsClients: wss ? wss.clients.size : 0
  });
});

// ===== 创建HTTP服务器 + WebSocket =====
const server = http.createServer(app);

// 关键修复：确保WS在服务器启动后初始化
server.on('listening', () => {
  const addr = server.address();
  console.log(`🚀 服务器启动成功: http://${addr.address}:${addr.port}`);
  
  // 初始化WebSocket
  wss = new WebSocket.Server({ server });
  console.log('✅ WebSocket服务已初始化');

  wss.on('connection', (ws, req) => {
    const clientIP = getClientIP(req);
    console.log(`🔌 新连接: IP=${clientIP}`);

    // 检查禁言
    if (mutedIPs.includes(clientIP)) {
      ws.send(JSON.stringify({ type: 'muted', message: '你已被管理员禁言' }));
      ws.close();
      console.log(`🚫 禁言用户连接被拒绝: ${clientIP}`);
      return;
    }

    // 添加到在线用户
    const user = {
      ws: ws,
      ip: clientIP,
      username: '',
      isMuted: false
    };
    onlineUsers.push(user);
    updateOnlineCount();

    // 接收消息
    ws.on('message', (data) => {
      try {
        const msgData = JSON.parse(data);
        const username = (msgData.username || '').trim();
        const content = (msgData.content || '').trim();
        const isAdmin = !!msgData.isAdmin;
        const isPrivate = !!msgData.isPrivate;
        const targetIP = (msgData.targetIP || '').trim();
        const isImage = !!msgData.isImage;

        if (!username) return;
        user.username = username;

        // 禁言检查
        if (user.isMuted) {
          ws.send(JSON.stringify({ type: 'error', message: '你已被禁言' }));
          return;
        }

        // 私聊逻辑
        if (isPrivate && targetIP) {
          const targetUser = findUserByIP(targetIP);
          if (!targetUser) {
            ws.send(JSON.stringify({ type: 'error', message: '对方不在线' }));
            return;
          }

          // 保存私聊消息
          db.run(
            'INSERT INTO messages (username, content, isAdmin, isPrivate, privateTarget, ip, isImage) VALUES (?, ?, ?, 1, ?, ?, ?)',
            [username, content, isAdmin ? 1 : 0, targetIP, clientIP, isImage ? 1 : 0],
            (err) => {
              if (err) console.error('保存私聊消息失败:', err.message);
            }
          );

          // 发送私聊消息
          const privateMsg = JSON.stringify({
            type: 'privateChat',
            data: {
              from: { username: username, ip: clientIP },
              to: { username: targetUser.username || '未命名', ip: targetIP },
              content: content,
              isImage: isImage,
              timestamp: new Date().toLocaleString()
            }
          });

          // 发送给双方
          if (ws.readyState === WebSocket.OPEN) ws.send(privateMsg);
          if (targetUser.ws.readyState === WebSocket.OPEN) targetUser.ws.send(privateMsg);
          return;
        }

        // 普通消息逻辑
        db.run(
          'INSERT INTO messages (username, content, isAdmin, ip, isImage) VALUES (?, ?, ?, ?, ?)',
          [username, content, isAdmin ? 1 : 0, clientIP, isImage ? 1 : 0],
          (err) => {
            if (err) console.error('保存普通消息失败:', err.message);
          }
        );

        // 广播普通消息
        const broadcastMsg = JSON.stringify({
          type: 'chat',
          data: {
            username: username,
            content: content,
            isAdmin: isAdmin,
            isImage: isImage,
            timestamp: new Date().toLocaleString()
          }
        });

        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(broadcastMsg);
          }
        });
      } catch (err) {
        console.error('解析消息失败:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
      }
    });

    // 断开连接
    ws.on('close', () => {
      console.log(`🔌 连接断开: IP=${clientIP}`);
      onlineUsers = onlineUsers.filter(u => u.ws !== ws);
      updateOnlineCount();
    });

    // WS错误处理
    ws.onerror = (err) => {
      console.error(`❌ WS错误: IP=${clientIP}`, err.message);
      onlineUsers = onlineUsers.filter(u => u.ws !== ws);
      updateOnlineCount();
    };
  });

  wss.on('error', (err) => {
    console.error('❌ WebSocket服务错误:', err.message);
  });
});

// 关键修复：处理端口配置（兼容Render环境）
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  // 这里的回调会被server.on('listening')覆盖，仅做兜底
  console.log(`服务器监听端口: ${PORT}`);
});

// 全局错误捕获
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获异常:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ 未处理的Promise拒绝:', reason);
});
