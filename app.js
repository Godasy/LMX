const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'Lmx%%112233';

let onlineUsers = [];
let chatRooms = [
  { id: 'default', name: '默认聊天室', desc: '所有人可进入的公共聊天室' }
];

// 修复：数据库路径使用绝对路径且避免特殊字符
const dbPath = path.resolve(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接SQLite数据库，路径：', dbPath);
    createTables();
    loadChatRoomsFromDB();
  }
});

// 工具函数：转义SQL特殊字符
function escapeSqlString(str) {
  if (!str) return '';
  // 转义单引号、斜杠、百分号等特殊字符
  return str.replace(/'/g, "''").replace(/\\/g, '\\\\').replace(/\//g, '\/');
}

// 工具函数：生成安全的ID（仅字母+数字）
function generateSafeId(prefix = 'id') {
  return prefix + '_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
}

function createTables() {
  // 修复：SQL语句格式化，避免语法错误
  const chatroomsSql = `
    CREATE TABLE IF NOT EXISTS chatrooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      desc TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const messagesSql = `
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      is_red INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const friendsSql = `
    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, friend_id)
    )
  `;

  const friendAppliesSql = `
    CREATE TABLE IF NOT EXISTS friend_applies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      from_name TEXT NOT NULL,
      to_id TEXT NOT NULL,
      status INTEGER DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const noticesSql = `
    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // 执行建表语句（按顺序）
  db.run(chatroomsSql, (err) => {
    if (err) console.error('创建chatrooms表失败:', err);
  });
  db.run(messagesSql, (err) => {
    if (err) console.error('创建messages表失败:', err);
  });
  db.run(friendsSql, (err) => {
    if (err) console.error('创建friends表失败:', err);
  });
  db.run(friendAppliesSql, (err) => {
    if (err) console.error('创建friend_applies表失败:', err);
  });
  db.run(noticesSql, (err) => {
    if (err) console.error('创建notices表失败:', err);
  });
}

function loadChatRoomsFromDB() {
  // 修复：使用参数化查询，避免注入/语法错误
  db.all('SELECT * FROM chatrooms ORDER BY create_time ASC', (err, rows) => {
    if (!err && rows.length > 0) {
      chatRooms = rows;
      console.log('加载聊天室数量:', chatRooms.length);
    } else {
      // 插入默认聊天室（确保ID无特殊字符）
      db.run(
        'INSERT OR IGNORE INTO chatrooms (id, name, desc) VALUES (?, ?, ?)',
        ['default', '默认聊天室', '所有人可进入的公共聊天室'],
        (err) => {
          if (err) console.error('插入默认聊天室失败:', err);
        }
      );
    }
  });
}

function broadcastToAll(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(message));
      } catch (err) {
        console.error('广播消息失败:', err);
      }
    }
  });
}

function getClientIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress || '';
  // 修复：清理IP中的特殊字符
  return ip.replace(/::ffff:/, '').replace(/[^0-9a-fA-F:\.]/g, '');
}

// ===================== API接口 =====================
app.get('/api/chatrooms', (req, res) => {
  res.json({ success: true, rooms: chatRooms });
});

app.post('/api/chatrooms', (req, res) => {
  const { name, desc, adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  // 修复：验证并转义聊天室名称
  const safeName = escapeSqlString(name?.trim() || '');
  if (!safeName) {
    return res.json({ success: false, message: '聊天室名称不能为空' });
  }
  
  const safeDesc = escapeSqlString(desc?.trim() || '');
  const roomId = generateSafeId('room'); // 生成安全ID
  
  // 修复：严格使用参数化查询
  db.run(
    'INSERT INTO chatrooms (id, name, desc) VALUES (?, ?, ?)',
    [roomId, safeName, safeDesc],
    (err) => {
      if (err) {
        console.error('创建聊天室失败:', err);
        return res.json({ success: false, message: '创建失败：' + err.message });
      }
      
      const newRoom = { id: roomId, name: safeName, desc: safeDesc };
      chatRooms.push(newRoom);
      broadcastToAll({ type: 'chatRooms', rooms: chatRooms });
      res.json({ success: true, room: newRoom });
    }
  );
});

app.delete('/api/chatrooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const { adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  if (roomId === 'default') {
    return res.json({ success: false, message: '不能删除默认聊天室' });
  }
  
  // 修复：参数化删除，避免语法错误
  db.run('DELETE FROM chatrooms WHERE id = ?', [roomId], (err) => {
    if (err) {
      console.error('删除聊天室失败:', err);
      return res.json({ success: false, message: '删除失败' });
    }
  });
  
  db.run('DELETE FROM messages WHERE room_id = ?', [roomId], (err) => {
    if (err) console.error('删除聊天室消息失败:', err);
  });
  
  chatRooms = chatRooms.filter(r => r.id !== roomId);
  broadcastToAll({ type: 'chatRooms', rooms: chatRooms });
  res.json({ success: true, message: '聊天室已删除' });
});

app.get('/api/chatrooms/:roomId/messages', (req, res) => {
  const { roomId } = req.params;
  
  // 修复：参数化查询消息
  db.all(
    'SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC',
    [roomId],
    (err, rows) => {
      if (err) {
        console.error('获取消息失败:', err);
        return res.json({ success: false, messages: [] });
      }
      res.json({ success: true, messages: rows || [] });
    }
  );
});

app.post('/api/admin/notice', (req, res) => {
  const { content, adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  const safeContent = escapeSqlString(content?.trim() || '');
  if (!safeContent) {
    return res.json({ success: false, message: '公告内容不能为空' });
  }
  
  // 修复：参数化插入公告
  db.run(
    'INSERT INTO notices (content) VALUES (?)',
    [safeContent],
    (err) => {
      if (err) {
        console.error('保存公告失败:', err);
        return res.json({ success: false, message: '发送失败' });
      }
      
      broadcastToAll({
        type: 'notice',
        content: safeContent,
        timestamp: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      });
      res.json({ success: true, message: '公告发送成功' });
    }
  );
});

app.post('/api/admin/red-message', (req, res) => {
  const { content, roomId, adminPwd } = req.body;
  
  if (adminPwd !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  
  const safeContent = escapeSqlString(content?.trim() || '');
  if (!safeContent) {
    return res.json({ success: false, message: '消息内容不能为空' });
  }
  
  const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  
  // 修复：参数化插入红色消息
  if (roomId && roomId !== '') {
    db.run(
      'INSERT INTO messages (room_id, username, content, is_admin, is_red, timestamp) VALUES (?, ?, ?, 1, 1, ?)',
      [roomId, '管理员', safeContent, timestamp],
      (err) => {
        if (err) console.error('保存红色消息失败:', err);
      }
    );
  }
  
  broadcastToAll({
    type: 'adminRedMessage',
    content: safeContent,
    roomId: roomId || '',
    timestamp: timestamp
  });
  
  res.json({ success: true, message: '红色消息发送成功' });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'alive', 
    onlineUsers: onlineUsers.length, 
    chatRooms: chatRooms.length,
    dbPath: dbPath,
    time: new Date().toLocaleString()
  });
});

// ===================== WebSocket服务 =====================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = getClientIP(req);
  let userInfo = null;
  console.log('新连接：IP =', ip);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()); // 修复：确保转成字符串解析
      
      switch (msg.type) {
        case 'online':
          // 修复：验证并转义用户ID/名称
          const safeUserId = escapeSqlString(msg.userId?.trim() || '');
          const safeUserName = escapeSqlString(msg.userName?.trim() || '未知用户');
          
          userInfo = { 
            id: safeUserId, 
            name: safeUserName, 
            ip: ip, 
            ws: ws 
          };
          onlineUsers.push(userInfo);
          console.log('用户上线：', safeUserName, '(', safeUserId, ')');
          break;

        case 'chat':
          // 修复：转义所有用户输入内容
          const safeChatRoomId = escapeSqlString(msg.roomId || 'default');
          const safeChatUsername = escapeSqlString(msg.username || '未知用户');
          const safeChatContent = escapeSqlString(msg.content || '');
          const safeChatTime = escapeSqlString(msg.timestamp || new Date().toLocaleString());
          
          if (!safeChatContent) break;
          
          const chatMsg = {
            type: 'chat',
            data: {
              roomId: safeChatRoomId,
              username: safeChatUsername,
              content: safeChatContent,
              timestamp: safeChatTime,
              isAdmin: !!msg.isAdmin
            }
          };
          
          // 修复：参数化插入聊天消息
          db.run(
            'INSERT INTO messages (room_id, username, content, is_admin, timestamp) VALUES (?, ?, ?, ?, ?)',
            [safeChatRoomId, safeChatUsername, safeChatContent, msg.isAdmin ? 1 : 0, safeChatTime],
            (err) => {
              if (err) console.error('保存聊天消息失败:', err);
            }
          );
          
          broadcastToAll(chatMsg);
          break;

        case 'privateChat':
          const pvMsg = {
            type: 'privateChat',
            data: { 
              from: {
                id: escapeSqlString(msg.from.id || ''),
                name: escapeSqlString(msg.from.name || '')
              },
              to: { id: escapeSqlString(msg.to.id || '') },
              content: escapeSqlString(msg.content || ''),
              timestamp: escapeSqlString(msg.timestamp || new Date().toLocaleString())
            }
          };
          
          const toUser = onlineUsers.find(u => u.id === pvMsg.data.to.id);
          if (toUser && toUser.ws.readyState === WebSocket.OPEN) {
            toUser.ws.send(JSON.stringify(pvMsg));
          }
          ws.send(JSON.stringify(pvMsg));
          break;

        case 'friendApply':
          const safeFromId = escapeSqlString(msg.fromId || '');
          const safeFromName = escapeSqlString(msg.fromName || '');
          const safeToId = escapeSqlString(msg.toId || '');
          
          const applyMsg = {
            type: 'friendApply',
            data: { 
              fromId: safeFromId, 
              fromName: safeFromName, 
              fromIp: ip,
              toId: safeToId 
            }
          };
          
          // 修复：参数化插入好友申请
          db.run(
            'INSERT INTO friend_applies (from_id, from_name, to_id) VALUES (?, ?, ?)',
            [safeFromId, safeFromName, safeToId],
            (err) => {
              if (err) console.error('保存好友申请失败:', err);
            }
          );
          
          const targetUser = onlineUsers.find(u => u.id === safeToId);
          if (targetUser && targetUser.ws.readyState === WebSocket.OPEN) {
            targetUser.ws.send(JSON.stringify(applyMsg));
          }
          break;

        case 'friendAgree':
          const agreeFromId = escapeSqlString(msg.fromId || '');
          const agreeToId = escapeSqlString(msg.toId || '');
          const agreeFromName = escapeSqlString(msg.fromName || '');
          
          // 修复：参数化更新好友申请状态
          db.run(
            'UPDATE friend_applies SET status = 1 WHERE from_id = ? AND to_id = ?',
            [agreeToId, agreeFromId],
            (err) => {
              if (err) console.error('更新好友申请失败:', err);
            }
          );
          
          // 修复：参数化插入好友关系
          db.run(
            'INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)',
            [agreeFromId, agreeToId],
            (err) => {
              if (err) console.error('保存好友关系1失败:', err);
            }
          );
          
          db.run(
            'INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)',
            [agreeToId, agreeFromId],
            (err) => {
              if (err) console.error('保存好友关系2失败:', err);
            }
          );
          
          const agreeMsg = {
            type: 'friendAgree',
            data: { 
              friend: { 
                id: agreeFromId, 
                name: agreeFromName 
              } 
            }
          };
          
          const applyUser = onlineUsers.find(u => u.id === agreeToId);
          if (applyUser && applyUser.ws.readyState === WebSocket.OPEN) {
            applyUser.ws.send(JSON.stringify(agreeMsg));
          }
          break;
      }
    } catch (e) {
      console.error('处理WebSocket消息失败:', e);
    }
  });

  ws.on('close', () => {
    console.log('连接关闭：IP =', ip);
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
  console.log(`服务器成功启动，端口：${PORT}`);
  console.log(`WebSocket地址：wss://localhost:${PORT}`);
});

// 全局错误捕获
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', promise, '原因:', reason);
});
