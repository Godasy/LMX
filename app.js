const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs'); // 密码加密

const app = express();
// denodeplay 会自动分配端口，无需手动指定固定端口
const PORT = process.env.PORT || 3000;

// 配置 CORS，允许前端域名访问
app.use(cors({
  origin: 'https://lmx.is-best.net', // 仅允许前端域名跨域
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 连接 SQLite 数据库（denodeplay 支持本地文件存储）
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接到 SQLite 数据库');
    // 创建用户表（不存在则创建）
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('创建用户表失败:', err.message);
      } else {
        console.log('用户表初始化完成');
      }
    });
  }
});

// 生成 8 位随机唯一 ID（数字+大小写字母）
function generateRandomId() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// 校验 ID 是否已存在
function checkIdExists(id, callback) {
  db.get('SELECT id FROM users WHERE id = ?', [id], (err, row) => {
    if (err) {
      callback(err, true); // 出错默认认为存在
    } else {
      callback(null, !!row); // 存在返回 true，不存在返回 false
    }
  });
}

// 获取唯一 ID（递归确保不重复）
function getUniqueId(callback) {
  const newId = generateRandomId();
  checkIdExists(newId, (err, exists) => {
    if (err) {
      callback(err);
    } else if (exists) {
      getUniqueId(callback); // 重复则重新生成
    } else {
      callback(null, newId);
    }
  });
}

// 注册接口
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;

  // 基础参数校验
  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: '用户名和密码不能为空'
    });
  }

  // 密码长度校验
  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: '密码长度不能少于 6 位'
    });
  }

  // 获取唯一 ID
  getUniqueId((err, userId) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: '生成用户 ID 失败，请重试'
      });
    }

    // 密码加密（10 轮盐值）
    bcrypt.hash(password, 10, (hashErr, hashedPassword) => {
      if (hashErr) {
        return res.status(500).json({
          success: false,
          message: '密码加密失败'
        });
      }

      // 插入用户数据
      db.run(
        'INSERT INTO users (id, username, password) VALUES (?, ?, ?)',
        [userId, username, hashedPassword],
        function (insertErr) {
          if (insertErr) {
            // 用户名重复
            if (insertErr.message.includes('UNIQUE constraint failed')) {
              return res.status(409).json({
                success: false,
                message: '用户名已存在，请更换'
              });
            }
            return res.status(500).json({
              success: false,
              message: '注册失败',
              error: insertErr.message
            });
          }

          // 注册成功返回数据
          res.status(200).json({
            success: true,
            message: '注册成功！',
            data: {
              userId: userId,
              username: username
            }
          });
        }
      );
    });
  });
});

// 登录接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: '用户名和密码不能为空'
    });
  }

  // 查询用户
  db.get(
    'SELECT id, username, password FROM users WHERE username = ?',
    [username],
    (err, user) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: '服务器错误'
        });
      }

      // 用户不存在
      if (!user) {
        return res.status(401).json({
          success: false,
          message: '用户名或密码错误'
        });
      }

      // 验证密码
      bcrypt.compare(password, user.password, (compareErr, isMatch) => {
        if (compareErr || !isMatch) {
          return res.status(401).json({
            success: false,
            message: '用户名或密码错误'
          });
        }

        // 登录成功
        res.status(200).json({
          success: true,
          message: '登录成功！',
          data: {
            userId: user.id,
            username: user.username
          }
        });
      });
    }
  );
});

// 健康检查接口（denodeplay 平台检测用）
app.get('/', (req, res) => {
  res.send({
    status: 'success',
    message: '服务运行正常',
    timestamp: new Date().toISOString()
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器已启动，端口：${PORT}`);
  console.log(`访问地址：http://localhost:${PORT}`);
});

// 进程退出时关闭数据库连接
process.on('exit', () => {
  db.close((err) => {
    if (err) {
      console.error('关闭数据库失败:', err.message);
    } else {
      console.log('数据库连接已关闭');
    }
  });
});
