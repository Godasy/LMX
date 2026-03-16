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
let chatRooms = [ // 默认聊天室
  { id: 'default', name: '默认聊天室', desc: '所有人可进入的公共聊天室' }
];
let registeredUserIds = new Set(); // 全局唯一ID池（内存+数据库同步）

// 初始化数据库
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接SQLite数据库');
    
    // 创建必要的表
    createTables();
    
    // 加载基础数据
    loadChatRoomsFromDB();
    loadRegisteredUserIds(); // 加载已注册ID到内存
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
  
  // 聊天消息表（按聊天室区分）
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_red INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
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
    status INTEGER DEFAULT 0, // 0-待处理 1-已同意 2-已拒绝
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // 系统公告表
  db.run(`CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // 用户注册表（新增：存储全局唯一ID）
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    ip TEXT NOT NULL,
    is_active INTEGER DEFAULT 1, // 1-活跃 0-注销
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // 私聊消息表（新增：存储好友私聊记录）
  db.run(`CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

// 加载已注册用户ID到内存（保证ID唯一性）
function loadRegisteredUserIds() {
  db.all('SELECT id FROM users WHERE is_active = 1', (err, rows) => {
    if (!err && rows.length > 0) {
      rows.forEach(row => registeredUserIds.add(row.id));
      console.log(`加载已注册ID数量: ${registeredUserIds.size}`);
    }
  });
}

// 从数据库加载聊天室
function loadChatRoomsFromDB() {
  db.all('SELECT * FROM chatrooms', (err, rows) => {
    if (!err && rows.length > 0) {
      chatRooms = rows;
      console.log('加载聊天室:', chatRooms);
    } else {
      // 插入默认聊天室
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

// 工具函数：发送私聊消息给指定用户
function sendPrivateMessage(toUserId, message) {
  // 查找目标用户的WebSocket连接
  const targetUser = onlineUsers.find(user => user.id === toUserId);
  if (targetUser && targetUser.ws.readyState === WebSocket.OPEN) {
    targetUser.ws.send(JSON.stringify(message));
  }
}

// 工具函数：获取客户端IP
function getClientIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
             req.connection.remoteAddress || 
             req.socket.remoteAddress || 
             req.connection.socket.remoteAddress || '';
  return ip.replace(/::ffff:/, ''); // 处理IPv6兼容格式
}

// ===================== 新增用户管理API =====================

// 1. 检查ID是否已存在
app.post('/api/check-id', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.json({ success: false, message: 'ID不能为空' });
  }
  
  // 先查内存（快速），再查数据库（兜底）
  if (registeredUserIds.has(userId)) {
    return res.json({ success: true, exists: true });
  }
  
  db.get('SELECT id FROM users WHERE id = ? AND is_active = 1', [userId], (err, row) => {
    if (err) {
      return res.json({ success: false, message: '查询失败' });
    }
    res.json({ success: true, exists: !!row });
  });
});

// 2. 用户注册（保证ID唯一）
app.post('/api/register', (req, res) => {
  const { userId, password, userName } = req.body;
  
  // 基础校验
  if (!userId || !password || !userName) {
    return res.json({ success: false, message: '参数不完整' });
  }
  
  if (userId.length < 4) {
    return res.json({ success: false, message: 'ID长度不能少于4位' });
  }
  
  if (password.length < 6) {
    return res.json({ success: false, message: '密码长度不能少于6位' });
  }
  
  // 检查ID是否已存在
  if (registeredUserIds.has(userId)) {
    return res.json({ success: false, message: '该ID已被注册，请更换ID' });
  }
  
  const clientIP = getClientIP(req);
  
  // 写入数据库
  db.run(`INSERT INTO users (id, name, password, ip) VALUES (?, ?, ?, ?)`,
    [userId, userName, password, clientIP], (err) => {
      if (err) {
        console.error('注册失败:', err);
        return res.json({ success: false, message: '该ID已被注册，请更换ID' });
      }
      
      // 更新内存ID池
      registeredUserIds.add(userId);
      
      res.json({ 
        success: true, 
        message: '注册成功',
        user: { id: userId, name: userName }
      });
    });
});

// 3. 用户登录
app.post('/api/login', (req, res) => {
  const { userId, password } = req.body;
  
  if (!userId || !password) {
    return res.json({ success: false, message: 'ID或密码不能为空' });
  }
  
  db.get('SELECT * FROM users WHERE id = ? AND is_active = 1', [userId], (err, row) => {
    if (err) {
      return res.json({ success: false, message: '登录失败' });
    }
    
    if (!row) {
      return res.json({ success: false, message: 'ID不存在或已注销' });
    }
    
    if (row.password !== password) {
      return res.json({ success: false, message: '密码错误' });
    }
    
    res.json({ 
      success: true, 
      user: { id: row.id, name: row.name, ip: row.ip }
    });
  });
});

// 4. 注销账号（释放ID）
app.post('/api/delete-account', (req, res) => {
  const { userId, password } = req.body;
  
  if (!userId || !password) {
    return res.json({ success: false, message: '参数不完整' });
  }
  
  // 验证密码
  db.get('SELECT * FROM users WHERE id = ? AND is_active = 1', [userId], (err, row) => {
    if (err || !row) {
      return res.json({ success: false, message: '用户不存在或已注销' });
    }
    
    if (row.password !== password) {
      return res.json({ success: false, message: '密码错误' });
    }
    
    // 标记为注销（软删除）
    db.run('UPDATE users SET is_active = 0, update_time = CURRENT_TIMESTAMP WHERE id = ?', [userId], (err) => {
      if (err) {
        return res.json({ success: false, message: '注销失败' });
      }
      
      // 从内存ID池移除（释放ID）
      registeredUserIds.delete(userId);
      
      // 删除关联数据（可选）
      db.run('DELETE FROM friends WHERE user_id = ? OR friend_id = ?', [userId, userId]);
      db.run('DELETE FROM friend_applies WHERE from_id = ? OR to_id = ?', [userId, userId]);
      
      res.json({ success: true, message: '账号已成功注销，ID可重新注册使用' });
    });
  });
});

// 5. 修改昵称
app.post('/api/update-name', (req, res) => {
  const { userId, newName } = req.body;
  
  if (!userId || !newName) {
    return res.json({ success: false, message: '参数不完整' });
  }
  
  db.run('UPDATE users SET name = ?, update_time = CURRENT_TIMESTAMP WHERE id = ? AND is_active = 1',
    [newName, userId], (err) => {
      if (err) {
        return res.json({ success: false, message: '修改失败' });
      }
      
      res.json({ success: true, message: '昵称修改成功', newName });
    });
});

// 6. 获取私聊记录
app.get('/api/private-messages/:friendId', (req, res) => {
  const { friendId } = req.params;
  const userId = req.query.userId;
  
  if (!userId || !friendId) {
    return res.json({ success: false, message: '参数不完整' });
  }
  
  // 查询双向消息
  db.all(`SELECT * FROM private_messages 
          WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
          ORDER BY timestamp ASC`,
    [userId, friendId, friendId, userId], (err, rows) => {
      if (err) {
        return res.json({ success: false, message: '获取记录失败' });
      }
      
      res.json({ success: true, messages: rows });
    });
});

// ===================== 原有API接口 =====================

// 1. 获取聊天室列表
app.get('/api/chatrooms', (req, res) => {
  res.json({
    success: true,
    rooms: chatRooms
  });
});

// 2. 新增聊天室
app.post('/api/chatrooms', (req, res) => {
  const { name, desc, adminPwd } = req.body;
  
  // 验证管理员密码
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  if (!name) {
    return res.json({ success: false, message: '聊天室名称不能为空' });
  }
  
  // 生成唯一ID
  const roomId = 'room_' + Date.now();
  
  // 保存到数据库
  db.run('INSERT INTO chatrooms (id, name, desc) VALUES (?, ?, ?)',
    [roomId, name, desc || ''], (err) => {
      if (err) {
        console.error('创建聊天室失败:', err);
        return res.json({ success: false, message: '创建失败' });
      }
      
      // 添加到内存
      const newRoom = { id: roomId, name, desc: desc || '' };
      chatRooms.push(newRoom);
      
      // 广播聊天室更新
      broadcastToAll({
        type: 'chatRooms',
        rooms: chatRooms
      });
      
      res.json({ success: true, room: newRoom });
    });
});

// 3. 删除聊天室
app.delete('/api/chatrooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const { adminPwd } = req.body;
  
  // 验证管理员密码
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  // 不能删除默认聊天室
  if (roomId === 'default') {
    return res.json({ success: false, message: '不能删除默认聊天室' });
  }
  
  // 从数据库删除
  db.run('DELETE FROM chatrooms WHERE id = ?', [roomId], (err) => {
    if (err) {
      console.error('删除聊天室失败:', err);
      return res.json({ success: false, message: '删除失败' });
    }
    
    // 删除该聊天室的消息
    db.run('DELETE FROM messages WHERE room_id = ?', [roomId]);
    
    // 从内存移除
    chatRooms = chatRooms.filter(room => room.id !== roomId);
    
    // 广播更新
    broadcastToAll({
      type: 'chatRooms',
      rooms: chatRooms
    });
    
    res.json({ success: true, message: '聊天室已删除' });
  });
});

// 4. 获取聊天室消息
app.get('/api/chatrooms/:roomId/messages', (req, res) => {
  const { roomId } = req.params;
  
  db.all('SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC', [roomId], (err, rows) => {
    if (err) {
      console.error('获取消息失败:', err);
      return res.json({ success: false, message: '获取失败' });
    }
    
    res.json({
      success: true,
      messages: rows
    });
  });
});

// 5. 发送系统公告
app.post('/api/admin/notice', (req, res) => {
  const { content, adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  if (!content) {
    return res.json({ success: false, message: '公告内容不能为空' });
  }
  
  // 保存到数据库
  db.run('INSERT INTO notices (content) VALUES (?)', [content], (err) => {
    if (err) {
      console.error('保存公告失败:', err);
      return res.json({ success: false, message: '发送失败' });
    }
    
    // 广播公告
    broadcastToAll({
      type: 'notice',
      content: content,
      timestamp: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    });
    
    res.json({ success: true, message: '公告发送成功' });
  });
});

// 6. 发送红色管理员消息
app.post('/api/admin/red-message', (req, res) => {
  const { content, roomId, adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  if (!content) {
    return res.json({ success: false, message: '消息内容不能为空' });
  }
  
  const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  
  // 保存到数据库（如果指定了聊天室）
  if (roomId) {
    db.run('INSERT INTO messages (room_id, username, content, is_admin, is_red, timestamp) VALUES (?, ?, ?, 1, 1, ?)',
      [roomId, '管理员', content, timestamp]);
  }
  
  // 广播红色消息
  broadcastToAll({
    type: 'adminRedMessage',
    content: content,
    roomId: roomId || '',
    timestamp: timestamp
  });
  
  res.json({ success: true, message: '红色消息发送成功' });
});

// ===================== WebSocket服务 =====================

// 创建HTTP服务器
const server = http.createServer(app);

// 创建WebSocket服务器
const wss = new WebSocket.Server({ server });

// WebSocket连接处理
wss.on('connection', (ws, req) => {
  console.log('新的WebSocket连接');
  
  // 获取客户端IP
  const clientIP = getClientIP(req);
  
  // 用户信息
  let userInfo = null;
  
  // 接收消息
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'online':
          // 用户上线
          userInfo = {
            id: msg.userId,
            name: msg.userName,
            ip: clientIP,
            ws: ws
          };
          onlineUsers.push(userInfo);
          console.log(`用户${msg.userName}(${msg.userId})上线`);
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
          
          // 广播给所有用户
          broadcastToAll(chatMsg);
          break;
          
        case 'privateChat':
          // 好友私聊 - 修复核心逻辑
          const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
          
          // 构建私聊消息
          const privateMsg = {
            type: 'privateChat',
            data: {
              from: {
                id: msg.from.id,
                name: msg.from.name
              },
              to: {
                id: msg.to.id
              },
              content: msg.content,
              timestamp: timestamp
            }
          };
          
          // 保存到数据库
          db.run('INSERT INTO private_messages (from_id, from_name, to_id, content, timestamp) VALUES (?, ?, ?, ?, ?)',
            [msg.from.id, msg.from.name, msg.to.id, msg.content, timestamp]);
          
          // 发送给接收方
          sendPrivateMessage(msg.to.id, privateMsg);
          
          // 回传给发送方（确保发送方能看到自己的消息）
          ws.send(JSON.stringify(privateMsg));
          break;
          
        case 'friendApply':
          // 好友申请
          const applyMsg = {
            type: 'friendApply',
            data: {
              fromId: msg.fromId,
              fromName: msg.fromName,
              fromIp: msg.fromIp,
              toId: msg.toId,
              time: new Date().getTime()
            }
          };
          
          // 保存到数据库
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
              friend: {
                id: msg.fromId,
                name: msg.fromName
              }
            }
          };
          
          // 更新数据库状态
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
    console.log('WebSocket连接关闭');
    if (userInfo) {
      onlineUsers = onlineUsers.filter(u => u.id !== userInfo.id);
    }
  });
  
  // 错误处理
  ws.onerror = (err) => {
    console.error('WebSocket错误:', err);
  };
});

// ===================== 启动服务器 =====================

// 静态文件托管（前端页面）
app.use(express.static(path.join(__dirname, 'public')));

// 启动HTTP服务器
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`WebSocket地址: ws://localhost:${PORT}`);
});

// 全局错误捕获
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', promise, '原因:', reason);
});
