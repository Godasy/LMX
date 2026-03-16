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

// 修复SQLite路径问题（适配Render部署）
const dbPath = path.resolve(__dirname, 'chat.db');
// 确保数据库文件目录存在
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 初始化SQLite数据库（修复部署错误）
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('SQLite数据库连接失败:', err.message);
    // 降级到内存数据库，避免部署失败
    db = new sqlite3.Database(':memory:');
    console.log('使用内存数据库继续运行');
  } else {
    console.log('SQLite数据库连接成功');
    // 初始化数据库表（确保表存在）
    initDatabase();
  }
});

// 初始化数据库表（解决SQLite表不存在错误）
function initDatabase() {
  // 聊天室表
  db.run(`CREATE TABLE IF NOT EXISTS chatrooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    desc TEXT,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 消息表
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_red INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES chatrooms(id)
  )`);

  // 用户表（新增ID唯一性）
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    pwd TEXT NOT NULL,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'active' -- active/inactive
  )`);

  // 好友关系表
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id)
  )`);

  // 好友申请表
  db.run(`CREATE TABLE IF NOT EXISTS friend_applies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- pending/accepted/rejected
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_id) REFERENCES users(id),
    FOREIGN KEY (to_id) REFERENCES users(id)
  )`);

  // 系统公告表
  db.run(`CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 插入默认聊天室（如果不存在）
  db.get(`SELECT id FROM chatrooms WHERE id = ?`, ['default'], (err, row) => {
    if (err) console.error('查询默认聊天室失败:', err);
    if (!row) {
      db.run(`INSERT INTO chatrooms (id, name, desc) VALUES (?, ?, ?)`, [
        'default',
        '默认聊天室',
        '所有人可进入的公共聊天室'
      ], (err) => {
        if (err) console.error('插入默认聊天室失败:', err);
      });
    }
  });
}

// 全局状态
let onlineUsers = []; // 在线用户
let chatRooms = []; // 聊天室列表

// 工具函数：广播消息给所有在线用户
function broadcastToAll(message) {
  if (wss && wss.clients) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
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

// 工具函数：校验ID唯一性
function checkUserIdUnique(userId, callback) {
  db.get(`SELECT id FROM users WHERE id = ? AND status = ?`, [userId, 'active'], (err, row) => {
    if (err) {
      callback(err, false);
    } else {
      callback(null, !row); // true=唯一，false=已存在
    }
  });
}

// ===================== API接口 =====================

// 1. 获取聊天室列表
app.get('/api/chatrooms', (req, res) => {
  db.all(`SELECT * FROM chatrooms`, (err, rows) => {
    if (err) {
      console.error('获取聊天室列表失败:', err);
      return res.json({ success: false, message: '获取失败', rooms: [] });
    }
    chatRooms = rows;
    res.json({ success: true, rooms: rows });
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
  db.run(`INSERT INTO chatrooms (id, name, desc) VALUES (?, ?, ?)`,
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
  db.run(`DELETE FROM chatrooms WHERE id = ?`, [roomId], (err) => {
    if (err) {
      console.error('删除聊天室失败:', err);
      return res.json({ success: false, message: '删除失败' });
    }

    // 删除该聊天室的消息
    db.run(`DELETE FROM messages WHERE room_id = ?`, [roomId]);

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

  db.all(`SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC`, [roomId], (err, rows) => {
    if (err) {
      console.error('获取消息失败:', err);
      return res.json({ success: false, message: '获取失败', messages: [] });
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
  db.run(`INSERT INTO notices (content) VALUES (?)`, [content], (err) => {
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
    db.run(`INSERT INTO messages (room_id, username, content, is_admin, is_red, timestamp) VALUES (?, ?, ?, 1, 1, ?)`,
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

// 7. 用户注册（新增ID唯一性校验）
app.post('/api/register', (req, res) => {
  const { userId, userPwd } = req.body;
  const clientIP = getClientIP(req);

  // 基础验证
  if (!userId || userId.length < 4) {
    return res.json({ success: false, message: 'ID长度不能少于4位' });
  }
  if (!userPwd || userPwd.length < 6) {
    return res.json({ success: false, message: '密码长度不能少于6位' });
  }

  // 校验ID唯一性
  checkUserIdUnique(userId, (err, isUnique) => {
    if (err) {
      return res.json({ success: false, message: '校验ID失败，请重试' });
    }
    if (!isUnique) {
      return res.json({ success: false, message: '该ID已被占用，请更换ID' });
    }

    // 保存用户信息
    const userName = '用户' + Math.floor(Math.random() * 1000);
    db.run(`INSERT INTO users (id, pwd, name, ip) VALUES (?, ?, ?, ?)`,
      [userId, userPwd, userName, clientIP], (err) => {
        if (err) {
          console.error('注册用户失败:', err);
          return res.json({ success: false, message: '注册失败，请重试' });
        }

        res.json({
          success: true,
          message: '注册成功',
          user: { id: userId, name: userName, ip: clientIP }
        });
      });
  });
});

// 8. 用户登录
app.post('/api/login', (req, res) => {
  const { userId, userPwd } = req.body;

  db.get(`SELECT * FROM users WHERE id = ? AND status = ?`, [userId, 'active'], (err, user) => {
    if (err) {
      return res.json({ success: false, message: '登录失败，请重试' });
    }
    if (!user) {
      return res.json({ success: false, message: 'ID不存在或已注销' });
    }
    if (user.pwd !== userPwd) {
      return res.json({ success: false, message: '密码错误' });
    }

    res.json({
      success: true,
      message: '登录成功',
      user: { id: user.id, name: user.name, ip: user.ip }
    });
  });
});

// 9. 注销账号（释放ID）
app.post('/api/delete-account', (req, res) => {
  const { userId, userPwd } = req.body;

  db.get(`SELECT * FROM users WHERE id = ? AND status = ?`, [userId, 'active'], (err, user) => {
    if (err) {
      return res.json({ success: false, message: '注销失败，请重试' });
    }
    if (!user) {
      return res.json({ success: false, message: 'ID不存在或已注销' });
    }
    if (user.pwd !== userPwd) {
      return res.json({ success: false, message: '密码错误' });
    }

    // 标记账号为注销（释放ID）
    db.run(`UPDATE users SET status = ? WHERE id = ?`, ['inactive', userId], (err) => {
      if (err) {
        return res.json({ success: false, message: '注销失败，请重试' });
      }

      // 删除该用户的好友关系
      db.run(`DELETE FROM friends WHERE user_id = ? OR friend_id = ?`, [userId, userId]);
      // 删除该用户的好友申请
      db.run(`DELETE FROM friend_applies WHERE from_id = ? OR to_id = ?`, [userId, userId]);

      res.json({ success: true, message: '账号已成功注销，ID已释放' });
    });
  });
});

// 10. 修改昵称
app.post('/api/edit-name', (req, res) => {
  const { userId, newName } = req.body;

  if (!newName || newName.length > 20) {
    return res.json({ success: false, message: '昵称不能为空且长度不超过20位' });
  }

  db.run(`UPDATE users SET name = ? WHERE id = ? AND status = ?`, [newName, userId, 'active'], (err) => {
    if (err) {
      return res.json({ success: false, message: '修改失败，请重试' });
    }

    res.json({ success: true, message: '昵称修改成功', name: newName });
  });
});

// 11. 添加好友
app.post('/api/add-friend', (req, res) => {
  const { fromId, toId } = req.body;

  // 检查双方是否为有效用户
  db.get(`SELECT id FROM users WHERE id = ? AND status = ?`, [toId, 'active'], (err, toUser) => {
    if (err || !toUser) {
      return res.json({ success: false, message: '好友ID不存在或已注销' });
    }

    // 检查是否已添加
    db.get(`SELECT id FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
      [fromId, toId, toId, fromId], (err, friend) => {
        if (err) {
          return res.json({ success: false, message: '检查好友关系失败' });
        }
        if (friend) {
          return res.json({ success: false, message: '已添加该用户为好友' });
        }

        // 保存好友申请
        db.get(`SELECT name FROM users WHERE id = ?`, [fromId], (err, fromUser) => {
          if (err || !fromUser) {
            return res.json({ success: false, message: '获取用户信息失败' });
          }

          db.run(`INSERT INTO friend_applies (from_id, from_name, to_id) VALUES (?, ?, ?)`,
            [fromId, fromUser.name, toId], (err) => {
              if (err) {
                return res.json({ success: false, message: '发送申请失败' });
              }

              // 广播好友申请
              broadcastToAll({
                type: 'friendApply',
                data: { fromId, fromName: fromUser.name, toId, time: Date.now() }
              });

              res.json({ success: true, message: '好友申请已发送' });
            });
        });
      });
  });
});

// 12. 同意好友申请
app.post('/api/agree-friend', (req, res) => {
  const { fromId, toId } = req.body;

  // 保存好友关系（双向）
  db.run(`INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)`, [toId, fromId]);
  db.run(`INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)`, [fromId, toId]);

  // 更新申请状态
  db.run(`UPDATE friend_applies SET status = ? WHERE from_id = ? AND to_id = ?`,
    ['accepted', fromId, toId]);

  // 获取用户信息
  db.get(`SELECT name FROM users WHERE id = ?`, [toId], (err, toUser) => {
    if (err || !toUser) {
      return res.json({ success: false, message: '获取用户信息失败' });
    }

    // 广播同意消息
    broadcastToAll({
      type: 'friendAgree',
      data: {
        friend: { id: toId, name: toUser.name },
        fromId,
        toId
      }
    });

    res.json({ success: true, message: '已同意好友申请' });
  });
});

// 13. 获取好友列表
app.get('/api/friends/:userId', (req, res) => {
  const { userId } = req.params;

  db.all(`SELECT u.id, u.name FROM friends f 
          JOIN users u ON f.friend_id = u.id 
          WHERE f.user_id = ? AND u.status = ?`,
    [userId, 'active'], (err, friends) => {
      if (err) {
        return res.json({ success: false, message: '获取好友失败', friends: [] });
      }

      res.json({ success: true, friends });
    });
});

// 14. 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    database: db.open ? 'connected' : 'disconnected',
    port: PORT
  });
});

// ===================== WebSocket服务 =====================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket连接处理
wss.on('connection', (ws, req) => {
  console.log('新的WebSocket连接');
  const clientIP = getClientIP(req);

  // 消息处理
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'online':
          // 用户上线
          onlineUsers.push({ id: msg.userId, name: msg.userName, ip: clientIP, ws });
          console.log(`用户${msg.userName}(${msg.userId})上线`);
          break;
          
        case 'chat':
          // 公聊消息
          db.run(`INSERT INTO messages (room_id, username, content, is_admin, timestamp) VALUES (?, ?, ?, ?, ?)`,
            [msg.roomId, msg.username, msg.content, msg.isAdmin ? 1 : 0, msg.timestamp]);
          // 广播消息（仅发送，不重复存储）
          broadcastToAll({ type: 'chat', data: msg });
          break;
          
        case 'privateChat':
          // 私聊消息
          broadcastToAll({ type: 'privateChat', data: msg });
          break;
          
        case 'friendApply':
          // 好友申请
          ws.send(JSON.stringify({
            type: 'friendApply',
            data: msg
          }));
          break;
          
        case 'friendAgree':
          // 同意好友
          ws.send(JSON.stringify({
            type: 'friendAgree',
            data: msg
          }));
          break;
      }
    } catch (err) {
      console.error('处理WebSocket消息失败:', err);
    }
  });

  // 连接关闭
  ws.on('close', () => {
    onlineUsers = onlineUsers.filter(user => user.ws !== ws);
    console.log('WebSocket连接关闭');
  });

  // 错误处理
  ws.onerror = (err) => {
    console.error('WebSocket错误:', err);
  };
});

// ===================== 静态文件托管 =====================
app.use(express.static(path.join(__dirname, 'public')));

// ===================== 启动服务器 =====================
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
