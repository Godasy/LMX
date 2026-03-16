const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const session = require('express-session');
const moment = require('moment');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// 配置时区为北京时间
moment.tz.setDefault('Asia/Shanghai');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 跨域配置
app.use(cors({
  origin: ['https://lmx.is-best.net'],
  credentials: true
}));

// 解析JSON和表单数据
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session配置（保持登录状态）
app.use(session({
  secret: 'chat-secret-key-123456',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7天有效期
    secure: true, // 生产环境开启
    sameSite: 'none'
  }
}));

// 连接SQLite数据库
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接到SQLite数据库');
    initDB(); // 初始化数据库表
  }
});

// 初始化数据库表
function initDB() {
  // 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // 聊天室表
  db.run(`CREATE TABLE IF NOT EXISTS chat_rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    creator_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    is_deleted INTEGER DEFAULT 0,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  )`);

  // 聊天室消息表
  db.run(`CREATE TABLE IF NOT EXISTS room_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    sender_id TEXT,
    content TEXT,
    send_time TEXT DEFAULT CURRENT_TIMESTAMP,
    is_admin_msg INTEGER DEFAULT 0,
    FOREIGN KEY (room_id) REFERENCES chat_rooms(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
  )`);

  // 私聊消息表
  db.run(`CREATE TABLE IF NOT EXISTS private_messages (
    id TEXT PRIMARY KEY,
    from_id TEXT,
    to_id TEXT,
    content TEXT,
    send_time TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_id) REFERENCES users(id),
    FOREIGN KEY (to_id) REFERENCES users(id)
  )`);

  // 好友关系表
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    friend_id TEXT,
    status INTEGER DEFAULT 0, // 0-申请中 1-已同意 2-已拒绝
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id),
    UNIQUE(user_id, friend_id)
  )`);

  // 在线用户表
  db.run(`CREATE TABLE IF NOT EXISTS online_users (
    user_id TEXT PRIMARY KEY,
    ip TEXT,
    ws_id TEXT,
    login_time TEXT DEFAULT CURRENT_TIMESTAMP,
    is_muted INTEGER DEFAULT 0 // 0-未禁言 1-已禁言
  )`);

  // 系统公告表
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    create_time TEXT DEFAULT CURRENT_TIMESTAMP,
    is_deleted INTEGER DEFAULT 0
  )`);

  // 创建默认聊天室
  db.get(`SELECT * FROM chat_rooms WHERE name = ?`, ['默认聊天室'], (err, row) => {
    if (!row) {
      db.run(`INSERT INTO chat_rooms (id, name, creator_id) VALUES (?, ?, ?)`, 
        [uuidv4(), '默认聊天室', 'system']);
    }
  });
}

// 全局变量：存储在线WS连接
const onlineWS = new Map(); // ws_id -> { ws, user_id, ip }

// ==================== 基础工具函数 ====================
// 获取北京时间
function getBeijingTime() {
  return moment().format('YYYY-MM-DD HH:mm:ss');
}

// 验证用户是否登录
function checkLogin(req, res, next) {
  if (!req.session.user) {
    return res.json({ code: 401, msg: '请先登录' });
  }
  next();
}

// 验证是否为管理员
function checkAdmin(req, res, next) {
  if (!req.session.user || req.session.user.is_admin !== 1) {
    return res.json({ code: 403, msg: '无管理员权限' });
  }
  next();
}

// ==================== 用户相关接口 ====================
// 注册接口
app.post('/api/register', (req, res) => {
  const { id, name, password } = req.body;
  
  if (!id || !name || !password) {
    return res.json({ code: 400, msg: 'ID、名称、密码不能为空' });
  }

  // 检查ID是否已存在（未被删除的用户）
  db.get(`SELECT * FROM users WHERE id = ? AND is_deleted = 0`, [id], (err, row) => {
    if (err) {
      return res.json({ code: 500, msg: '服务器错误', error: err.message });
    }
    if (row) {
      return res.json({ code: 409, msg: '该ID已被占用' });
    }

    // 创建新用户
    db.run(`INSERT INTO users (id, name, password) VALUES (?, ?, ?)`, 
      [id, name, password], (err) => {
        if (err) {
          return res.json({ code: 500, msg: '注册失败', error: err.message });
        }
        res.json({ code: 200, msg: '注册成功' });
      });
  });
});

// 登录接口
app.post('/api/login', (req, res) => {
  const { id, password } = req.body;
  
  if (!id || !password) {
    return res.json({ code: 400, msg: 'ID和密码不能为空' });
  }

  // 检查用户是否存在且未被删除
  db.get(`SELECT * FROM users WHERE id = ? AND is_deleted = 0`, [id], (err, row) => {
    if (err) {
      return res.json({ code: 500, msg: '服务器错误', error: err.message });
    }
    if (!row) {
      return res.json({ code: 404, msg: '用户不存在' });
    }
    if (row.password !== password) {
      return res.json({ code: 401, msg: '密码错误' });
    }

    // 记录登录状态
    req.session.user = {
      id: row.id,
      name: row.name,
      is_admin: row.is_admin
    };

    res.json({ 
      code: 200, 
      msg: '登录成功', 
      data: { user: req.session.user } 
    });
  });
});

// 退出登录
app.post('/api/logout', checkLogin, (req, res) => {
  const userId = req.session.user.id;
  
  // 移除在线用户记录
  db.run(`DELETE FROM online_users WHERE user_id = ?`, [userId]);
  
  // 关闭WS连接
  for (const [wsId, wsData] of onlineWS.entries()) {
    if (wsData.user_id === userId) {
      wsData.ws.close();
      onlineWS.delete(wsId);
    }
  }

  // 销毁session
  req.session.destroy();
  res.json({ code: 200, msg: '退出登录成功' });
});

// 获取当前用户信息
app.get('/api/user/info', checkLogin, (req, res) => {
  res.json({ 
    code: 200, 
    data: { user: req.session.user } 
  });
});

// 修改用户名
app.post('/api/user/rename', checkLogin, (req, res) => {
  const { newName } = req.body;
  const userId = req.session.user.id;
  
  if (!newName) {
    return res.json({ code: 400, msg: '新名称不能为空' });
  }

  db.run(`UPDATE users SET name = ? WHERE id = ?`, [newName, userId], (err) => {
    if (err) {
      return res.json({ code: 500, msg: '修改失败', error: err.message });
    }
    // 更新session中的名称
    req.session.user.name = newName;
    res.json({ code: 200, msg: '名称修改成功', data: { newName } });
  });
});

// 注销账号
app.post('/api/user/delete', checkLogin, (req, res) => {
  const userId = req.session.user.id;
  
  // 标记用户为已删除
  db.run(`UPDATE users SET is_deleted = 1 WHERE id = ?`, [userId], (err) => {
    if (err) {
      return res.json({ code: 500, msg: '注销失败', error: err.message });
    }

    // 移除在线记录
    db.run(`DELETE FROM online_users WHERE user_id = ?`, [userId]);
    
    // 销毁session
    req.session.destroy();
    res.json({ code: 200, msg: '账号注销成功' });
  });
});

// ==================== 聊天室相关接口 ====================
// 获取聊天室列表
app.get('/api/rooms', checkLogin, (req, res) => {
  db.all(`SELECT cr.*, 
    (SELECT COUNT(*) FROM online_users ou 
     JOIN room_messages rm ON ou.user_id = rm.sender_id 
     WHERE rm.room_id = cr.id) as online_count
    FROM chat_rooms cr WHERE cr.is_deleted = 0`, (err, rows) => {
    if (err) {
      return res.json({ code: 500, msg: '获取失败', error: err.message });
    }
    res.json({ code: 200, data: { rooms: rows } });
  });
});

// 创建聊天室
app.post('/api/rooms/create', checkLogin, (req, res) => {
  const { name } = req.body;
  const userId = req.session.user.id;
  
  if (!name) {
    return res.json({ code: 400, msg: '聊天室名称不能为空' });
  }

  // 检查名称是否重复
  db.get(`SELECT * FROM chat_rooms WHERE name = ? AND is_deleted = 0`, [name], (err, row) => {
    if (err) {
      return res.json({ code: 500, msg: '服务器错误', error: err.message });
    }
    if (row) {
      return res.json({ code: 409, msg: '该聊天室名称已存在' });
    }

    // 创建聊天室
    const roomId = uuidv4();
    db.run(`INSERT INTO chat_rooms (id, name, creator_id) VALUES (?, ?, ?)`, 
      [roomId, name, userId], (err) => {
        if (err) {
          return res.json({ code: 500, msg: '创建失败', error: err.message });
        }
        res.json({ code: 200, msg: '聊天室创建成功', data: { roomId, name } });
      });
  });
});

// 获取聊天室消息
app.get('/api/rooms/:roomId/messages', checkLogin, (req, res) => {
  const { roomId } = req.params;
  
  db.all(`SELECT rm.*, u.name as sender_name, u.is_admin 
    FROM room_messages rm 
    LEFT JOIN users u ON rm.sender_id = u.id 
    WHERE rm.room_id = ? 
    ORDER BY rm.send_time ASC`, [roomId], (err, rows) => {
    if (err) {
      return res.json({ code: 500, msg: '获取消息失败', error: err.message });
    }
    res.json({ code: 200, data: { messages: rows } });
  });
});

// ==================== 好友相关接口 ====================
// 添加好友申请
app.post('/api/friends/add', checkLogin, (req, res) => {
  const { friendId } = req.body;
  const userId = req.session.user.id;
  
  if (!friendId) {
    return res.json({ code: 400, msg: '好友ID不能为空' });
  }
  if (friendId === userId) {
    return res.json({ code: 400, msg: '不能添加自己为好友' });
  }

  // 检查好友是否存在
  db.get(`SELECT * FROM users WHERE id = ? AND is_deleted = 0`, [friendId], (err, row) => {
    if (err) {
      return res.json({ code: 500, msg: '服务器错误', error: err.message });
    }
    if (!row) {
      return res.json({ code: 404, msg: '好友不存在' });
    }

    // 检查是否已发送申请
    db.get(`SELECT * FROM friends WHERE user_id = ? AND friend_id = ?`, 
      [userId, friendId], (err, row) => {
        if (err) {
          return res.json({ code: 500, msg: '服务器错误', error: err.message });
        }
        if (row) {
          let msg = '';
          if (row.status === 0) msg = '已发送好友申请，等待对方同意';
          if (row.status === 1) msg = '对方已是你的好友';
          if (row.status === 2) msg = '对方已拒绝你的好友申请';
          return res.json({ code: 409, msg });
        }

        // 发送好友申请
        db.run(`INSERT INTO friends (id, user_id, friend_id, status) VALUES (?, ?, ?, 0)`, 
          [uuidv4(), userId, friendId], (err) => {
            if (err) {
              return res.json({ code: 500, msg: '发送申请失败', error: err.message });
            }
            res.json({ code: 200, msg: '好友申请已发送' });
          });
      });
  });
});

// 获取好友申请列表
app.get('/api/friends/applications', checkLogin, (req, res) => {
  const userId = req.session.user.id;
  
  db.all(`SELECT f.*, u.id as apply_user_id, u.name as apply_user_name 
    FROM friends f 
    LEFT JOIN users u ON f.user_id = u.id 
    WHERE f.friend_id = ? AND f.status = 0`, [userId], (err, rows) => {
    if (err) {
      return res.json({ code: 500, msg: '获取申请列表失败', error: err.message });
    }
    res.json({ code: 200, data: { applications: rows } });
  });
});

// 处理好友申请
app.post('/api/friends/handle', checkLogin, (req, res) => {
  const { applyId, status } = req.body; // status:1-同意 2-拒绝
  const userId = req.session.user.id;
  
  if (!applyId || !status) {
    return res.json({ code: 400, msg: '参数不能为空' });
  }

  db.run(`UPDATE friends SET status = ? WHERE id = ? AND friend_id = ?`, 
    [status, applyId, userId], (err) => {
      if (err) {
        return res.json({ code: 500, msg: '处理申请失败', error: err.message });
      }
      const msg = status === 1 ? '已同意好友申请' : '已拒绝好友申请';
      res.json({ code: 200, msg });
    });
});

// 获取好友列表
app.get('/api/friends/list', checkLogin, (req, res) => {
  const userId = req.session.user.id;
  
  db.all(`SELECT f.*, u.id as friend_id, u.name as friend_name 
    FROM friends f 
    LEFT JOIN users u ON 
      (f.user_id = ? AND f.friend_id = u.id) OR 
      (f.friend_id = ? AND f.user_id = u.id)
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 1`, 
    [userId, userId, userId, userId], (err, rows) => {
    if (err) {
      return res.json({ code: 500, msg: '获取好友列表失败', error: err.message });
    }
    res.json({ code: 200, data: { friends: rows } });
  });
});

// ==================== 管理员接口 ====================
// 删除聊天室
app.post('/api/admin/room/delete', checkAdmin, (req, res) => {
  const { roomId } = req.body;
  
  db.run(`UPDATE chat_rooms SET is_deleted = 1 WHERE id = ?`, [roomId], (err) => {
    if (err) {
      return res.json({ code: 500, msg: '删除失败', error: err.message });
    }
    res.json({ code: 200, msg: '聊天室已删除' });
  });
});

// 禁言用户IP
app.post('/api/admin/user/mute', checkAdmin, (req, res) => {
  const { ip, isMuted } = req.body;
  
  db.run(`UPDATE online_users SET is_muted = ? WHERE ip = ?`, [isMuted ? 1 : 0, ip], (err) => {
    if (err) {
      return res.json({ code: 500, msg: '操作失败', error: err.message });
    }
    const msg = isMuted ? '已禁言该IP' : '已解除该IP禁言';
    res.json({ code: 200, msg });
  });
});

// 发送系统公告
app.post('/api/admin/announcement/add', checkAdmin, (req, res) => {
  const { content } = req.body;
  
  const annId = uuidv4();
  db.run(`INSERT INTO announcements (id, content) VALUES (?, ?)`, 
    [annId, content], (err) => {
      if (err) {
        return res.json({ code: 500, msg: '发布失败', error: err.message });
      }
      // 推送给所有在线用户
      broadcastMessage({
        type: 'announcement',
        data: { id: annId, content, create_time: getBeijingTime() }
      });
      res.json({ code: 200, msg: '公告发布成功' });
    });
});

// 删除公告
app.post('/api/admin/announcement/delete', checkAdmin, (req, res) => {
  const { annId } = req.body;
  
  db.run(`UPDATE announcements SET is_deleted = 1 WHERE id = ?`, [annId], (err) => {
    if (err) {
      return res.json({ code: 500, msg: '删除失败', error: err.message });
    }
    res.json({ code: 200, msg: '公告已删除' });
  });
});

// 获取所有用户聊天记录
app.get('/api/admin/records/all', checkAdmin, (req, res) => {
  // 聊天室消息
  db.all(`SELECT rm.*, u.name as sender_name, cr.name as room_name 
    FROM room_messages rm 
    LEFT JOIN users u ON rm.sender_id = u.id 
    LEFT JOIN chat_rooms cr ON rm.room_id = cr.id`, (err, roomMsgs) => {
    if (err) {
      return res.json({ code: 500, msg: '获取失败', error: err.message });
    }

    // 私聊消息
    db.all(`SELECT pm.*, u1.name as from_name, u2.name as to_name 
      FROM private_messages pm 
      LEFT JOIN users u1 ON pm.from_id = u1.id 
      LEFT JOIN users u2 ON pm.to_id = u2.id`, (err, privateMsgs) => {
      if (err) {
        return res.json({ code: 500, msg: '获取失败', error: err.message });
      }

      res.json({ 
        code: 200, 
        data: { 
          room_messages: roomMsgs,
          private_messages: privateMsgs 
        } 
      });
    });
  });
});

// ==================== WebSocket 实时通信 ====================
// 广播消息给所有在线用户
function broadcastMessage(data) {
  const jsonData = JSON.stringify(data);
  for (const [_, wsData] of onlineWS.entries()) {
    if (wsData.ws.readyState === WebSocket.OPEN) {
      wsData.ws.send(jsonData);
    }
  }
}

// 广播消息给指定聊天室用户
function broadcastToRoom(roomId, data) {
  const jsonData = JSON.stringify(data);
  for (const [_, wsData] of onlineWS.entries()) {
    if (wsData.ws.readyState === WebSocket.OPEN && wsData.current_room === roomId) {
      wsData.ws.send(jsonData);
    }
  }
}

// 发送私聊消息
function sendPrivateMessage(toUserId, data) {
  const jsonData = JSON.stringify(data);
  for (const [_, wsData] of onlineWS.entries()) {
    if (wsData.ws.readyState === WebSocket.OPEN && wsData.user_id === toUserId) {
      wsData.ws.send(jsonData);
      break;
    }
  }
}

// 处理WS连接
wss.on('connection', (ws, req) => {
  const wsId = uuidv4();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  // 验证用户是否登录
  let userId = null;
  const cookies = req.headers.cookie || '';
  const sessionCookie = cookies.split('; ').find(row => row.startsWith('connect.sid='));
  
  if (sessionCookie) {
    // 这里简化处理，实际生产环境需要解析session
    // 此处仅为演示，实际需结合session存储验证
    userId = 'temp-user-' + Math.random().toString(36).substr(2, 9);
  }

  // 记录在线WS
  onlineWS.set(wsId, { ws, user_id: userId, ip, current_room: null });
  
  // 记录在线用户
  if (userId) {
    db.run(`REPLACE INTO online_users (user_id, ip, ws_id) VALUES (?, ?, ?)`, 
      [userId, ip, wsId]);
  }

  // 处理WS消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const wsData = onlineWS.get(wsId);
      
      // 检查是否被禁言
      db.get(`SELECT is_muted FROM online_users WHERE user_id = ?`, [userId], (err, row) => {
        if (row && row.is_muted === 1) {
          ws.send(JSON.stringify({ type: 'error', msg: '你已被禁言' }));
          return;
        }

        switch (data.type) {
          // 进入聊天室
          case 'join_room':
            wsData.current_room = data.roomId;
            ws.send(JSON.stringify({ 
              type: 'join_success', 
              msg: '已进入聊天室',
              roomId: data.roomId 
            }));
            break;

          // 发送聊天室消息
          case 'send_room_msg':
            const msgId = uuidv4();
            const sendTime = getBeijingTime();
            
            // 保存消息到数据库
            db.run(`INSERT INTO room_messages 
              (id, room_id, sender_id, content, send_time, is_admin_msg) 
              VALUES (?, ?, ?, ?, ?, ?)`, 
              [msgId, data.roomId, userId, data.content, sendTime, data.isAdmin || 0]);
            
            // 广播消息
            broadcastToRoom(data.roomId, {
              type: 'room_msg',
              data: {
                id: msgId,
                room_id: data.roomId,
                sender_id: userId,
                content: data.content,
                send_time: sendTime,
                is_admin_msg: data.isAdmin || 0
              }
            });
            break;

          // 发送私聊消息
          case 'send_private_msg':
            const privateMsgId = uuidv4();
            const privateSendTime = getBeijingTime();
            
            // 保存私聊消息
            db.run(`INSERT INTO private_messages 
              (id, from_id, to_id, content, send_time) 
              VALUES (?, ?, ?, ?, ?)`, 
              [privateMsgId, userId, data.toId, data.content, privateSendTime]);
            
            // 发送给对方
            sendPrivateMessage(data.toId, {
              type: 'private_msg',
              data: {
                id: privateMsgId,
                from_id: userId,
                to_id: data.toId,
                content: data.content,
                send_time: privateSendTime
              }
            });
            
            // 回复发送者
            ws.send(JSON.stringify({
              type: 'private_msg_success',
              data: { id: privateMsgId }
            }));
            break;

          default:
            ws.send(JSON.stringify({ type: 'error', msg: '未知消息类型' }));
        }
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', msg: '消息格式错误' }));
    }
  });

  // 处理WS断开
  ws.on('close', () => {
    // 移除在线WS记录
    onlineWS.delete(wsId);
    
    // 更新在线用户记录
    if (userId) {
      db.run(`DELETE FROM online_users WHERE ws_id = ?`, [wsId]);
    }
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});

// 错误处理
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason, promise);
});
