const axios = require('axios');

// Render 后端的域名（部署后替换）
const RENDER_URL = 'https://your-chat-backend.onrender.com';

// 每14分钟请求一次（Render 免费版15分钟无请求休眠）
const keepAlive = async () => {
  try {
    const res = await axios.get(`${RENDER_URL}/health`);
    console.log('保活请求成功:', res.data);
  } catch (err) {
    console.error('保活请求失败:', err.message);
  }
};

// 启动时执行一次，之后定时执行
keepAlive();
setInterval(keepAlive, 14 * 60 * 1000); // 14分钟