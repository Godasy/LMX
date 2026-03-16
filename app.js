const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

// 初始化Express
const app = express();
app.use(cors());
app.use(express.json());

// 全局配置
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'Lmx%%112233';

// 全局状态
let onlineUsers = []; // 在线用户
let chatRooms = [{ id: 'default', name: '默认聊天室', desc: '所有人可进入的公共聊天室' }]; // 默认聊天室

// 初始化数据库
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接SQLite数据库');
    createTables();
    loadChatRoomsFromDB();
  }
});

// 创建数据库表
function createTables() {
  // 聊天室表
  db.run(`CREATE TABLE IF NOT EXISTS chatrooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    desc TEXT,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // 聊天消息表
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_red INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // 用户表（新增：存储用户ID，保证唯一）
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    status INTEGER DEFAULT 1 -- 1-正常 0-注销
  )`);
  
  // 好友关系表
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
  )`);
  
  // 好友申请表
  db.run(`CREATE TABLE IF NOT EXISTS friend_applies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_id TEXT NOT NULL,
    status INTEGER DEFAULT 0, -- 0-待处理 1-已同意 2-已拒绝
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // 系统公告表
  db.run(`CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // 私聊消息表（新增：存储私聊记录）
  db.run(`CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

// 从数据库加载聊天室
function loadChatRoomsFromDB() {
  db.all('SELECT * FROM chatrooms', (err, rows) => {
    if (!err && rows.length > 0) {
      chatRooms = rows;
    } else {
      db.run('INSERT OR IGNORE INTO chatrooms (id, name, desc) VALUES (?, ?, ?)',
        ['default', '默认聊天室', '所有人可进入的公共聊天室']);
    }
  });
}

// 工具函数：广播消息给所有在线用户
function broadcastToAll(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// 工具函数：发送私聊消息
function sendPrivateMessage(toUserId, message) {
  const targetUser = onlineUsers.find(u => u.id === toUserId);
  if (targetUser && targetUser.ws.readyState === WebSocket.OPEN) {
    targetUser.ws.send(JSON.stringify(message));
  }
}

// ===================== API接口 =====================

// 1. 获取聊天室列表
app.get('/api/chatrooms', (req, res) => {
  res.json({ success: true, rooms: chatRooms });
});

// 2. 新增聊天室
app.post('/api/chatrooms', (req, res) => {
  const { name, desc, adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  if (!name) {
    return res.json({ success: false, message: '聊天室名称不能为空' });
  }
  
  const roomId = 'room_' + Date.now();
  
  db.run('INSERT INTO chatrooms (id, name, desc) VALUES (?, ?, ?)',
    [roomId, name, desc || ''], (err) => {
      if (err) return res.json({ success: false, message: '创建失败' });
      
      const newRoom = { id: roomId, name, desc: desc || '' };
      chatRooms.push(newRoom);
      
      broadcastToAll({ type: 'chatRooms', rooms: chatRooms });
      res.json({ success: true, room: newRoom });
    });
});

// 3. 删除聊天室
app.delete('/api/chatrooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const { adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  if (roomId === 'default') {
    return res.json({ success: false, message: '不能删除默认聊天室' });
  }
  
  db.run('DELETE FROM chatrooms WHERE id = ?', [roomId], (err) => {
    if (err) return res.json({ success: false, message: '删除失败' });
    
    db.run('DELETE FROM messages WHERE room_id = ?', [roomId]);
    chatRooms = chatRooms.filter(room => room.id !== roomId);
    
    broadcastToAll({ type: 'chatRooms', rooms: chatRooms });
    res.json({ success: true, message: '聊天室已删除' });
  });
});

// 4. 获取聊天室消息
app.get('/api/chatrooms/:roomId/messages', (req, res) => {
  const { roomId } = req.params;
  
  db.all('SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC', [roomId], (err, rows) => {
    if (err) return res.json({ success: false, message: '获取失败' });
    res.json({ success: true, messages: rows });
  });
});

// 5. 获取私聊消息（新增）
app.get('/api/private-messages/:friendId', (req, res) => {
  const { friendId } = req.params;
  const userId = req.query.userId;
  
  db.all(`SELECT * FROM private_messages 
          WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
          ORDER BY timestamp ASC`, 
    [userId, friendId, friendId, userId], (err, rows) => {
      if (err) return res.json({ success: false, message: '获取失败' });
      res.json({ success: true, messages: rows });
    });
});

// 6. 发送系统公告
app.post('/api/admin/notice', (req, res) => {
  const { content, adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  if (!content) {
    return res.json({ success: false, message: '公告内容不能为空' });
  }
  
  db.run('INSERT INTO notices (content) VALUES (?)', [content], (err) => {
    if (err) return res.json({ success: false, message: '发送失败' });
    
    broadcastToAll({
      type: 'notice',
      content: content,
      timestamp: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    });
    
    res.json({ success: true, message: '公告发送成功' });
  });
});

// 7. 发送红色管理员消息
app.post('/api/admin/red-message', (req, res) => {
  const { content, roomId, adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  if (!content) {
    return res.json({ success: false, message: '消息内容不能为空' });
  }
  
  const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  
  if (roomId) {
    db.run('INSERT INTO messages (room_id, username, content, is_admin, is_red, timestamp) VALUES (?, ?, ?, 1, 1, ?)',
      [roomId, '管理员', content, timestamp]);
  }
  
  broadcastToAll({
    type: 'adminRedMessage',
    content: content,
    roomId: roomId || '',
    timestamp: timestamp
  });
  
  res.json({ success: true, message: '红色消息发送成功' });
});

// 8. 用户注册（新增：保证ID唯一）
app.post('/api/register', (req, res) => {
  const { id, password, name } = req.body;
  
  if (!id || !password || !name) {
    return res.json({ success: false, message: 'ID、密码、昵称不能为空' });
  }
  
  // 检查ID是否已存在（未注销）
  db.get('SELECT id FROM users WHERE id = ? AND status = 1', [id], (err, row) => {
    if (err) return res.json({ success: false, message: '注册失败' });
    
    if (row) {
      return res.json({ success: false, message: 'ID已存在，无法注册' });
    }
    
    // 注册用户（注销的ID可重新注册）
    db.run(`INSERT OR REPLACE INTO users (id, password, name, status) 
            VALUES (?, ?, ?, 1)`, [id, password, name], (err) => {
      if (err) return res.json({ success: false, message: '注册失败' });
      res.json({ success: true, message: '注册成功' });
    });
  });
});

// 9. 用户登录
app.post('/api/login', (req, res) => {
  const { id, password } = req.body;
  
  db.get('SELECT * FROM users WHERE id = ? AND status = 1', [id], (err, row) => {
    if (err) return res.json({ success: false, message: '登录失败' });
    
    if (!row) {
      return res.json({ success: false, message: 'ID不存在或已注销' });
    }
    
    if (row.password !== password) {
      return res.json({ success: false, message: '密码错误' });
    }
    
    res.json({ 
      success: true, 
      user: { id: row.id, name: row.name } 
    });
  });
});

// 10. 注销账号（新增：标记status为0，ID可复用）
app.post('/api/logout-account', (req, res) => {
  const { id } = req.body;
  
  db.run('UPDATE users SET status = 0 WHERE id = ?', [id], (err) => {
    if (err) return res.json({ success: false, message: '注销失败' });
    
    // 删除该用户的好友关系
    db.run('DELETE FROM friends WHERE user_id = ? OR friend_id = ?', [id, id]);
    res.json({ success: true, message: '注销成功' });
  });
});

// 11. 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'alive',
    onlineUsers: onlineUsers.length,
    chatRooms: chatRooms.length,
    time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
  });
});

// ===================== WebSocket服务 =====================

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket连接处理
wss.on('connection', (ws, req) => {
  let userInfo = null;
  
  // 接收消息
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'online':
          // 用户上线
          userInfo = { id: msg.userId, name: msg.userName, ws: ws };
          onlineUsers.push(userInfo);
          break;
          
        case 'chat':
          // 公聊消息
          const chatMsg = {
            type: 'chat',
            data: {
              roomId: msg.roomId,
              username: msg.username,
              content: msg.content,
              timestamp: msg.timestamp,
              isAdmin: msg.isAdmin
            }
          };
          
          // 保存到数据库
          db.run('INSERT INTO messages (room_id, username, content, is_admin, timestamp) VALUES (?, ?, ?, ?, ?)',
            [msg.roomId, msg.username, msg.content, msg.isAdmin ? 1 : 0, msg.timestamp]);
          
          broadcastToAll(chatMsg);
          break;
          
        case 'privateChat':
          // 私聊消息（修复：保存+定向发送）
          const privateMsg = {
            type: 'privateChat',
            data: {
              from: { id: msg.from.id, name: msg.from.name },
              to: { id: msg.to.id },
              content: msg.content,
              timestamp: msg.timestamp
            }
          };
          
          // 保存私聊记录到数据库
          db.run('INSERT INTO private_messages (from_id, from_name, to_id, content, timestamp) VALUES (?, ?, ?, ?, ?)',
            [msg.from.id, msg.from.name, msg.to.id, msg.content, msg.timestamp]);
          
          // 发送给接收方
          sendPrivateMessage(msg.to.id, privateMsg);
          // 回传给发送方
          ws.send(JSON.stringify(privateMsg));
          break;
          
        case 'friendApply':
          // 好友申请
          const applyMsg = {
            type: 'friendApply',
            data: {
              fromId: msg.fromId,
              fromName: msg.fromName,
              toId: msg.toId
            }
          };
          
          db.run('INSERT INTO friend_applies (from_id, from_name, to_id) VALUES (?, ?, ?)',
            [msg.fromId, msg.fromName, msg.toId]);
          
          // 发送给被申请人
          sendPrivateMessage(msg.toId, applyMsg);
          break;
          
        case 'friendAgree':
          // 同意好友申请
          const agreeMsg = {
            type: 'friendAgree',
            data: {
              friend: { id: msg.fromId, name: msg.fromName }
            }
          };
          
          db.run('UPDATE friend_applies SET status = 1 WHERE from_id = ? AND to_id = ?',
            [msg.toId, msg.fromId]);
          
          // 保存好友关系
          db.run('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)',
            [msg.fromId, msg.toId]);
          db.run('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)',
            [msg.toId, msg.fromId]);
          
          // 发送给申请人
          sendPrivateMessage(msg.toId, agreeMsg);
          break;
      }
    } catch (err) {
      console.error('处理WebSocket消息失败:', err);
    }
  });
  
  // 连接关闭
  ws.on('close', () => {
    if (userInfo) {
      onlineUsers = onlineUsers.filter(u => u.id !== userInfo.id);
    }
  });
  
  ws.onerror = (err) => {
    console.error('WebSocket错误:', err);
  };
});

// 静态文件托管
app.use(express.static(path.join(__dirname, 'public')));

// 启动服务器
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});

// 全局错误捕获
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', promise, '原因:', reason);
});
