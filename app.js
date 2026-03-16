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

// 初始化数据库
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接SQLite数据库');
    
    // 创建必要的表
    createTables();
    
    // 加载聊天室
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

// ===================== API接口 =====================

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
  
  // 保存到数据库
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
    time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
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
          db.run('INSERT INTO messages (room_id, username, content, is_admin, timestamp) VALUES (?, ?, ?, ?, ?)',
            [msg.roomId, msg.username, msg.content, msg.isAdmin ? 1 : 0, msg.timestamp]);
          
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
