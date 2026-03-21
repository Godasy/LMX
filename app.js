// main.ts
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { hash, compare } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
import { v4 as uuidv4 } from "https://esm.sh/uuid@9.0.1";

// Supabase 配置
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 存储在线用户的 WebSocket 连接
const onlineUsers = new Map<string, WebSocket>();

// 生成 6 位数字+字母的唯一用户ID
async function generateUniqueUserId(): Promise<string> {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let userId: string;
  do {
    userId = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    // 检查ID是否已存在
    const { data } = await supabase.from("users").select("id").eq("id", userId);
  } while (data && data.length > 0);
  return userId;
}

// 处理 HTTP 请求（注册/登录）
async function handleHttp(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 处理
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "https://lmx.is-best.net",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // 注册接口
  if (path === "/api/register" && request.method === "POST") {
    try {
      const { username, password } = await request.json();
      
      // 检查用户名是否已存在
      const { data: existingUser } = await supabase.from("users").select("id").eq("username", username);
      if (existingUser && existingUser.length > 0) {
        return new Response(JSON.stringify({ success: false, message: "用户名已存在" }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://lmx.is-best.net" },
          status: 400,
        });
      }

      // 生成唯一ID + 密码哈希
      const userId = await generateUniqueUserId();
      const passwordHash = await hash(password);

      // 保存用户
      const { error } = await supabase.from("users").insert({
        id: userId,
        username,
        password_hash: passwordHash,
      });

      if (error) throw error;
      return new Response(JSON.stringify({ success: true, userId, username }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://lmx.is-best.net" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, message: error.message }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://lmx.is-best.net" },
        status: 500,
      });
    }
  }

  // 登录接口
  if (path === "/api/login" && request.method === "POST") {
    try {
      const { username, password } = await request.json();
      
      // 查询用户
      const { data: user } = await supabase.from("users").select("id, username, password_hash").eq("username", username);
      if (!user || user.length === 0) {
        return new Response(JSON.stringify({ success: false, message: "用户名或密码错误" }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://lmx.is-best.net" },
          status: 400,
        });
      }

      // 验证密码
      const passwordMatch = await compare(password, user[0].password_hash);
      if (!passwordMatch) {
        return new Response(JSON.stringify({ success: false, message: "用户名或密码错误" }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://lmx.is-best.net" },
          status: 400,
        });
      }

      return new Response(JSON.stringify({
        success: true,
        userId: user[0].id,
        username: user[0].username,
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://lmx.is-best.net" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, message: error.message }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://lmx.is-best.net" },
        status: 500,
      });
    }
  }

  // 获取历史消息
  if (path === "/api/messages" && request.method === "GET") {
    try {
      const { data: messages } = await supabase.from("messages")
        .select("*, users(username)")
        .order("created_at", { ascending: true });
      
      return new Response(JSON.stringify({ success: true, messages }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://lmx.is-best.net" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, message: error.message }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://lmx.is-best.net" },
        status: 500,
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}

// 处理 WebSocket 连接（实时聊天）
async function handleWebSocket(ws: WebSocket, userId: string, username: string) {
  // 保存用户连接
  onlineUsers.set(userId, ws);

  // 广播用户上线
  broadcast({
    type: "system",
    content: `${username} 加入了聊天室`,
    timestamp: new Date().toISOString(),
  });

  // 处理消息接收
  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type !== "chat") return;

      // 保存消息到数据库
      const { error } = await supabase.from("messages").insert({
        user_id: userId,
        content: message.content,
      });

      if (error) throw error;

      // 广播消息
      broadcast({
        type: "chat",
        userId,
        username,
        content: message.content,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Message error:", error);
    }
  };

  // 处理连接关闭
  ws.onclose = () => {
    onlineUsers.delete(userId);
    // 广播用户下线
    broadcast({
      type: "system",
      content: `${username} 离开了聊天室`,
      timestamp: new Date().toISOString(),
    });
  };

  // 处理错误
  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    onlineUsers.delete(userId);
  };
}

// 广播消息给所有在线用户
function broadcast(message: any) {
  const messageStr = JSON.stringify(message);
  for (const ws of onlineUsers.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  }
}

// 主服务入口
serve(async (request: Request) => {
  const url = new URL(request.url);
  
  // WebSocket 连接（需要携带 userId 和 username 参数）
  if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") {
    const userId = url.searchParams.get("userId");
    const username = url.searchParams.get("username");
    if (!userId || !username) {
      return new Response("Missing parameters", { status: 400 });
    }

    const { socket, response } = Deno.upgradeWebSocket(request);
    handleWebSocket(socket, userId, username);
    return response;
  }

  // 处理 HTTP 请求
  return handleHttp(request);
});
