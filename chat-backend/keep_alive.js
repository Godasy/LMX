const axios = require('axios');

// 你的Render后端域名
const RENDER_URL = 'https://lmx-w9ua.onrender.com';

// 每14分钟请求一次（防止Render休眠）
const keepAlive = async () => {
  try {
    const res = await axios.get(`${RENDER_URL}/health`);
    console.log('保活请求成功:', res.data);
  } catch (err) {
    console.error('保活请求失败:', err.message);
  }
};

// 启动时执行，之后定时执行
keepAlive();
setInterval(keepAlive, 14 * 60 * 1000); // 14分钟