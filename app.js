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
      
      // 广播更新
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
    
    // 广播
