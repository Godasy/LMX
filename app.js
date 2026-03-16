const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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

// 修复SQLite路径问题（兼容Render部署）
const dbDir = path.join(__dirname, 'data');
// 确保data目录存在
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'chat.db');

// 初始化数据库（增加错误处理和重试机制）
const db = new sqlite3.Database(dbPath, { timeout: 5000 }, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
    // 降级使用内存数据库，避免部署失败
    if (err.code === 'SQLITE_CANTOPEN') {
      console.log('降级使用内存数据库');
      db = new sqlite3.Database(':memory:');
      createTables();
      loadChatRoomsFromDB();
    }
  } else {
    console.log(`成功连接SQLite数据库: ${dbPath}`);
    // 创建必要的表
    createTables();
    // 加载聊天室
    loadChatRoomsFromDB();
  }
});

// 增加数据库操作重试包装
function dbRunWithRetry(sql, params = [], retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (currentTry) => {
      db.run(sql, params, function(err) {
        if (err) {
          if (currentTry > 0 && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED')) {
            console.log(`数据库忙，重试(${currentTry})`, err.message);
            setTimeout(() => attempt(currentTry - 1), 100 * (4 - currentTry));
          } else {
            reject(err);
          }
        } else {
          resolve(this);
        }
      });
    };
    attempt(retries);
  });
}

function dbAllWithRetry(sql, params = [], retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (currentTry) => {
      db.all(sql, params, function(err, rows) {
        if (err) {
          if (currentTry > 0 && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED')) {
            console.log(`数据库忙，重试(${currentTry})`, err.message);
            setTimeout(() => attempt(currentTry - 1), 100 * (4 - currentTry));
          } else {
            reject(err);
          }
        } else {
          resolve(rows);
        }
      });
    };
    attempt(retries);
  });
}

// 创建数据库表
function createTables() {
  // 聊天室表
  dbRunWithRetry(`CREATE TABLE IF NOT EXISTS chatrooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    desc TEXT,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).catch(err => console.error('创建chatrooms表失败:', err));
  
  // 聊天消息表（按聊天室区分）
  dbRunWithRetry(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_red INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).catch(err => console.error('创建messages表失败:', err));
  
  // 好友关系表
  dbRunWithRetry(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
  )`).catch(err => console.error('创建friends表失败:', err));
  
  // 好友申请表
  dbRunWithRetry(`CREATE TABLE IF NOT EXISTS friend_applies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_id TEXT NOT NULL,
    status INTEGER DEFAULT 0, // 0-待处理 1-已同意 2-已拒绝
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).catch(err => console.error('创建friend_applies表失败:', err));
  
  // 系统公告表
  dbRunWithRetry(`CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).catch(err => console.error('创建notices表失败:', err));
  
  // 用户注册表（新增：存储用户ID，确保唯一性）
  dbRunWithRetry(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1 // 1-活跃 0-注销
  )`).catch(err => console.error('创建users表失败:', err));
}

// 从数据库加载聊天室
async function loadChatRoomsFromDB() {
  try {
    const rows = await dbAllWithRetry('SELECT * FROM chatrooms');
    if (rows.length > 0) {
      chatRooms = rows;
      console.log('加载聊天室:', chatRooms);
    } else {
      // 插入默认聊天室
      await dbRunWithRetry('INSERT OR IGNORE INTO chatrooms (id, name, desc) VALUES (?, ?, ?)',
        ['default', '默认聊天室', '所有人可进入的公共聊天室']);
    }
  } catch (err) {
    console.error('加载聊天室失败:', err);
  }
}

// 工具函数：广播消息给所有在线用户
function broadcastToAll(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// 工具函数：获取客户端IP
function getClientIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
             req.connection.remoteAddress || 
             req.socket.remoteAddress || 
             req.connection.socket.remoteAddress || '';
  return ip.replace(/::ffff:/, ''); // 处理IPv6兼容格式
}

// ===================== 新增：用户ID相关API =====================

// 检查ID是否已存在
app.post('/api/check-id', async (req, res) => {
  const { userId } = req.body;
  try {
    const rows = await dbAllWithRetry('SELECT id FROM users WHERE id = ? AND is_active = 1', [userId]);
    res.json({ 
      success: true, 
      exists: rows.length > 0 
    });
  } catch (err) {
    console.error('检查ID失败:', err);
    res.json({ 
      success: false, 
      message: '检查ID失败',
      exists: false 
    });
  }
});

// 注册用户（确保ID唯一）
app.post('/api/register', async (req, res) => {
  const { userId, password, userName, ip } = req.body;
  
  try {
    // 检查ID是否已存在
    const existing = await dbAllWithRetry('SELECT id FROM users WHERE id = ? AND is_active = 1', [userId]);
    if (existing.length > 0) {
      return res.json({ 
        success: false, 
        message: '该ID已被使用，请更换ID' 
      });
    }
    
    // 插入新用户
    await dbRunWithRetry(
      'INSERT INTO users (id, password, name, ip) VALUES (?, ?, ?, ?)',
      [userId, password, userName, ip]
    );
    
    res.json({ 
      success: true, 
      message: '注册成功' 
    });
  } catch (err) {
    console.error('注册用户失败:', err);
    res.json({ 
      success: false, 
      message: '注册失败：' + err.message 
    });
  }
});

// 注销用户（释放ID）
app.post('/api/delete-account', async (req, res) => {
  const { userId, password } = req.body;
  
  try {
    // 验证用户
    const user = await dbAllWithRetry('SELECT id FROM users WHERE id = ? AND password = ? AND is_active = 1', [userId, password]);
    if (user.length === 0) {
      return res.json({ 
        success: false, 
        message: 'ID或密码错误' 
      });
    }
    
    // 标记为注销（释放ID）
    await dbRunWithRetry(
      'UPDATE users SET is_active = 0 WHERE id = ?',
      [userId]
    );
    
    // 删除相关好友关系
    await dbRunWithRetry('DELETE FROM friends WHERE user_id = ? OR friend_id = ?', [userId, userId]);
    await dbRunWithRetry('DELETE FROM friend_applies WHERE from_id = ? OR to_id = ?', [userId, userId]);
    
    res.json({ 
      success: true, 
      message: '账号已注销，ID已释放' 
    });
  } catch (err) {
    console.error('注销账号失败:', err);
    res.json({ 
      success: false, 
      message: '注销失败：' + err.message 
    });
  }
});

// ===================== 原有API接口（保持不变） =====================

// 1. 获取聊天室列表
app.get('/api/chatrooms', async (req, res) => {
  try {
    const rows = await dbAllWithRetry('SELECT * FROM chatrooms');
    res.json({
      success: true,
      rooms: rows
    });
  } catch (err) {
    console.error('获取聊天室列表失败:', err);
    res.json({
      success: false,
      message: '获取失败',
      rooms: chatRooms
    });
  }
});

// 2. 新增聊天室
app.post('/api/chatrooms', async (req, res) => {
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
  
  try {
    // 保存到数据库
    await dbRunWithRetry('INSERT INTO chatrooms (id, name, desc) VALUES (?, ?, ?)',
      [roomId, name, desc || '']);
    
    // 添加到内存
    const newRoom = { id: roomId, name, desc: desc || '' };
    chatRooms.push(newRoom);
    
    // 广播聊天室更新
    broadcastToAll({
      type: 'chatRooms',
      rooms: chatRooms
    });
    
    res.json({ success: true, room: newRoom });
  } catch (err) {
    console.error('创建聊天室失败:', err);
    res.json({ success: false, message: '创建失败：' + err.message });
  }
});

// 3. 删除聊天室
app.delete('/api/chatrooms/:roomId', async (req, res) => {
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
  
  try {
    // 从数据库删除
    await dbRunWithRetry('DELETE FROM chatrooms WHERE id = ?', [roomId]);
    
    // 删除该聊天室的消息
    await dbRunWithRetry('DELETE FROM messages WHERE room_id = ?', [roomId]);
    
    // 从内存移除
    chatRooms = chatRooms.filter(room => room.id !== roomId);
    
    // 广播更新
    broadcastToAll({
      type: 'chatRooms',
      rooms: chatRooms
    });
    
    res.json({ success: true, message: '聊天室已删除' });
  } catch (err) {
    console.error('删除聊天室失败:', err);
    res.json({ success: false, message: '删除失败：' + err.message });
  }
});

// 4. 获取聊天室消息
app.get('/api/chatrooms/:roomId/messages', async (req, res) => {
  const { roomId } = req.params;
  
  try {
    const rows = await dbAllWithRetry('SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC', [roomId]);
    res.json({
      success: true,
      messages: rows
    });
  } catch (err) {
    console.error('获取消息失败:', err);
    res.json({ success: false, message: '获取失败：' + err.message, messages: [] });
  }
});

// 5. 发送系统公告
app.post('/api/admin/notice', async (req, res) => {
  const { content, adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  if (!content) {
    return res.json({ success: false, message: '公告内容不能为空' });
  }
  
  try {
    // 保存到数据库
    await dbRunWithRetry('INSERT INTO notices (content) VALUES (?)', [content]);
    
    // 广播公告
    broadcastToAll({
      type: 'notice',
      content: content,
      timestamp: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    });
    
    res.json({ success: true, message: '公告发送成功' });
  } catch (err) {
    console.error('保存公告失败:', err);
    res.json({ success: false, message: '发送失败：' + err.message });
  }
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
    dbRunWithRetry('INSERT INTO messages (room_id, username, content, is_admin, is_red, timestamp) VALUES (?, ?, ?, 1, 1, ?)',
      [roomId, '管理员', content, timestamp]).catch(err => console.error('保存红色消息失败:', err));
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

// 7. 管理员登录（备用）
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin_' + Date.now() });
  } else {
    res.json({ success: false, message: '密码错误' });
  }
});

// 8. 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'alive',
    onlineUsers: onlineUsers.length,
    chatRooms: chatRooms.length,
    time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    dbPath: dbPath
  });
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
          dbRunWithRetry('INSERT INTO messages (room_id, username, content, is_admin, timestamp) VALUES (?, ?, ?, ?, ?)',
            [msg.roomId, msg.username, msg.content, msg.isAdmin ? 1 : 0, msg.timestamp])
            .catch(err => console.error('保存聊天消息失败:', err));
          
          // 广播给所有用户
          broadcastToAll(chatMsg);
          break;
          
        case 'privateChat':
          // 好友私聊
          const privateMsg = {
            type: 'privateChat',
            data: {
              from: msg.from,
              to: msg.to,
              content: msg.content,
              timestamp: msg.timestamp
            }
          };
          
          // 发送给接收方
          const targetUser = onlineUsers.find(u => u.id === msg.to.id);
          if (targetUser && targetUser.ws.readyState === WebSocket.OPEN) {
            targetUser.ws.send(JSON.stringify(privateMsg));
          }
          
          // 发送给发送方
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
          dbRunWithRetry('INSERT INTO friend_applies (from_id, from_name, to_id) VALUES (?, ?, ?)',
            [msg.fromId, msg.fromName, msg.toId])
            .catch(err => console.error('保存好友申请失败:', err));
          
          // 发送给被申请人
          const toUser = onlineUsers.find(u => u.id === msg.toId);
          if (toUser && toUser.ws.readyState === WebSocket.OPEN) {
            toUser.ws.send(JSON.stringify(applyMsg));
          }
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
          dbRunWithRetry('UPDATE friend_applies SET status = 1 WHERE from_id = ? AND to_id = ?',
            [msg.toId, msg.fromId])
            .catch(err => console.error('更新好友申请状态失败:', err));
          
          // 保存好友关系
          dbRunWithRetry('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)',
            [msg.fromId, msg.toId])
            .catch(err => console.error('保存好友关系1失败:', err));
          dbRunWithRetry('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)',
            [msg.toId, msg.fromId])
            .catch(err => console.error('保存好友关系2失败:', err));
          
          // 发送给申请人
          const applyUser = onlineUsers.find(u => u.id === msg.toId);
          if (applyUser && applyUser.ws.readyState === WebSocket.OPEN) {
            applyUser.ws.send(JSON.stringify(agreeMsg));
          }
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
  console.log(`数据库路径: ${dbPath}`);
});

// 全局错误捕获
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', promise, '原因:', reason);
});
