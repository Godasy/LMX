import { serve } from "https://deno.land/std@0.210.0/http/server.ts";

// 初始化 Deno KV 数据库
const kv = await Deno.openKv();

// 生成唯一用户ID（8位随机字符串，确保不重复）
async function generateUniqueId() {
  let id;
  let exists = true;
  while (exists) {
    id = Math.random().toString(36).substring(2, 10); // 生成8位随机ID
    const user = await kv.get(["users", id]);
    exists = user.value !== null;
  }
  return id;
}

// 处理请求
serve(async (req) => {
  // 处理跨域
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://lmx.is-best.net",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // 处理预检请求
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const url = new URL(req.url);

  // 1. 注册接口 POST /register
  if (url.pathname === "/register" && req.method === "POST") {
    try {
      const { username, password } = await req.json();
      
      // 校验参数
      if (!username || !password) {
        return new Response(JSON.stringify({ error: "用户名和密码不能为空" }), { status: 400, headers });
      }

      // 检查用户名是否已存在
      const existingUser = await kv.get(["user_by_username", username]);
      if (existingUser.value) {
        return new Response(JSON.stringify({ error: "用户名已存在" }), { status: 409, headers });
      }

      // 生成唯一ID
      const userId = await generateUniqueId();

      // 存储用户信息（密码实际场景应加密，此处为演示）
      const userData = { id: userId, username, password, createdAt: new Date().toISOString() };
      await kv.set(["users", userId], userData);
      await kv.set(["user_by_username", username], userId); // 建立用户名到ID的索引

      return new Response(JSON.stringify({ success: true, userId }), { status: 201, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: "参数解析失败" }), { status: 400, headers });
    }
  }

  // 2. 登录接口 POST /login
  if (url.pathname === "/login" && req.method === "POST") {
    try {
      const { username, password } = await req.json();
      
      // 查找用户
      const userIdEntry = await kv.get(["user_by_username", username]);
      if (!userIdEntry.value) {
        return new Response(JSON.stringify({ error: "用户不存在" }), { status: 401, headers });
      }

      const user = await kv.get(["users", userIdEntry.value]);
      if (user.value.password !== password) {
        return new Response(JSON.stringify({ error: "密码错误" }), { status: 401, headers });
      }

      return new Response(JSON.stringify({ success: true, userId: user.value.id }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: "参数解析失败" }), { status: 400, headers });
    }
  }

  // 404 处理
  return new Response(JSON.stringify({ error: "接口不存在" }), { status: 404, headers });
});
