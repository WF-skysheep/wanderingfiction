# Playground 2

当前项目包含三部分：
1. `index.html`：主页（九宫格、天气地图、BGM）
2. `tool.html`：OCR 识别/翻译工具
3. `wf.html` + `wf-server/`：源--WF（流浪小说）模块（本次新增）
4. `functions/wf/api/[[path]].js`：Pages 同域代理（将 `/wf/api/*` 转发到 Worker）

## 源--WF（流浪小说）模块结构

- `wf.html`：前端页面（登录、项目、消息中心、管理员台）
- `wf-server/app.js`：后端 API（auth/projects/continuations/messages/admin）
- `wf-server/ai-provider.js`：AI Provider 抽象层（mock / DeepSeek / OpenAI 可切换）
- `wf-server/db.js`：数据库初始化
- `wf-server/migrations/001_init.sql`：数据库 Schema 与迁移 SQL
- `wf-server/migrate.js`：迁移脚本
- `wf-server/server.js`：后端启动入口
- `wf-server/tests/wf.test.js`：基础测试（鉴权、续写锁、消息多条、删除规则）
- `.env.wf.example`：WF 环境变量示例

## 本地运行

### 1) 安装依赖

```bash
npm install
```

### 2) 启动 WF 后端

```bash
cp .env.wf.example .env
npm run wf:migrate
npm run wf:dev
```

默认后端地址：`http://localhost:8788`

### 3) 启动前端（Pages 本地）

```bash
npm run dev
```

然后访问：
- 主页：`http://localhost:8787/`
- 流浪小说：`http://localhost:8787/wf.html`

### 4) 运行测试

```bash
npm run wf:test
```

## WF 环境变量

- `WF_PORT`：后端端口（默认 `8788`）
- `WF_DB_PATH`：SQLite 数据库文件路径
- `WF_CORS_ORIGIN`：允许跨域前端地址（如 `http://localhost:8787`）
- `WF_ADMIN_USERNAME`：注册时自动赋管理员角色的用户名（默认 `admin`）
- `WF_AI_PROVIDER`：`mock` / `deepseek` / `openai`
- `DEEPSEEK_API_KEY`：DeepSeek 密钥（仅后端使用）
- `OPENAI_API_KEY`：OpenAI 密钥（仅后端使用）

## 部署说明

### 前端（Cloudflare Pages）

```bash
npm run deploy
```

### OCR/BGM Worker（已有）

```bash
npm run worker:deploy
```

### WF 后端并入现有 Worker（本次）

`/wf/api/*` 已并入 `worker-backend/index.js`，由同一个 Cloudflare Worker 提供服务。

1. 在 Cloudflare 创建 D1（若已创建可跳过）：
```bash
npx wrangler d1 create wf-db
```

2. 把返回的 `database_id` 填入 `wrangler.worker.toml` 的 `[[d1_databases]]`。

3. 执行迁移：
```bash
npm run worker:wf:migrate:remote
```

4. 部署 Worker：
```bash
npm run worker:deploy
```

5. 前端 `wf.html` 默认已指向你的 Worker 域名：
`https://restless-credit-a6e1.wangderingfiction.workers.dev`

可选：在浏览器控制台覆盖为其他后端域名：
```js
localStorage.setItem('WF_API_BASE', 'https://your-worker-domain.workers.dev')
```

### WF 后端（Node Server 方式）

部署到你的云服务器：

```bash
npm ci
npm run wf:migrate
WF_AI_PROVIDER=deepseek DEEPSEEK_API_KEY=xxx npm run wf:dev
```

建议用 PM2/systemd 托管，并反向代理到你的域名子路径（如 `/wf/api`）。
已提供部署示例：
- `wf-server/deploy/pm2.config.cjs`
- `wf-server/deploy/nginx.conf.example`

## 备注

- API Key 不会暴露到前端。
- 消息中心已实现“必须一键已读后才能关闭”。
- 已读消息会在查询时自动清理（超过 3 天）。
