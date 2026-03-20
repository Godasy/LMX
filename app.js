const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 连接SQLite数据库
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接到SQLite数据库');
    // 创建用户表（如果不存在）
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('创建表失败:', err.message);
      }
    });
  }
});

// 生成随机唯一ID（8位数字+字母组合）
function generateUniqueId() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// 校验ID是否已存在
function checkIdExists(id, callback) {
  db.get('SELECT id FROM users WHERE id = ?', [id], (err, row) => {
    if (err) {
      callback(err, true); // 出错默认认为存在
    } else {
      callback(null, !!row); // 存在返回true，不存在返回false
    }
  });
}

// 获取唯一ID
function getUniqueId(callback) {
  const id = generateUniqueId();
  checkIdExists(id, (err, exists) => {
    if (err) {
      callback(err);
    } else if (exists) {
      getUniqueId(callback); // 重复则重新生成
    } else {
      callback(null, id);
    }
  });
}

// 注册接口
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  
  // 参数校验
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }

  // 获取唯一ID
  getUniqueId((err, userId) => {
    if (err) {
      return res.status(500).json({ success: false, message: '生成用户ID失败' });
    }

    // 插入用户数据
    db.run(
      'INSERT INTO users (id, username, password) VALUES (?, ?, ?)',
      [userId, username, password], // 注意：生产环境需加密密码（如bcrypt）
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ success: false, message: '用户名已存在' });
          }
          return res.status(500).json({ success: false, message: '注册失败', error: err.message });
        }
        res.status(200).json({
          success: true,
          message: '注册成功',
          data: { userId, username }
        });
      }
    );
  });
});

// 登录接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }

  db.get(
    'SELECT id, username FROM users WHERE username = ? AND password = ?',
    [username, password],
    (err, row) => {
      if (err) {
        return res.status(500).json({ success: false, message: '登录失败', error: err.message });
      }
      if (!row) {
        return res.status(401).json({ success: false, message: '用户名或密码错误' });
      }
      res.status(200).json({
        success: true,
        message: '登录成功',
        data: { userId: row.id, username: row.username }
      });
    }
  );
});

// 测试接口
app.get('/', (req, res) => {
  res.send('Chat Backend Server Running!');
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在端口: ${PORT}`);
});

// 关闭数据库连接（进程退出时）
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('关闭数据库连接');
    process.exit(0);
  });
});
