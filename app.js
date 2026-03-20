import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { DB } from "https://deno.land/x/sqlite@v3.8/mod.ts";

const app = new Application();
const router = new Router();
const db = new DB("chat.db");

// 初始化用户表（首次运行执行）
db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 跨域中间件
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "https://lmx.is-best.net");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 200;
    return;
  }
  await next();
});

// 登录接口
router.post("/api/login", async (ctx) => {
  const body = await ctx.request.body().value;
  const { username, password } = body;

  const user = db.query("SELECT * FROM users WHERE username = ? AND password = ?", [
    username,
    password,
  ]);

  if (user.length) {
    ctx.response.body = { success: true, message: "登录成功" };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { success: false, message: "用户名或密码错误" };
  }
});

// 创建账号接口
router.post("/api/register", async (ctx) => {
  const body = await ctx.request.body().value;
  const { username, password } = body;

  try {
    db.query("INSERT INTO users (username, password) VALUES (?, ?)", [
      username,
      password,
    ]);
    ctx.response.body = { success: true, message: "注册成功" };
  } catch (e) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, message: "用户名已存在" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
