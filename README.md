# WanderingFiction（前端静态页 + 阿里云后端）

当前项目包含三部分：
- 前端静态页面：`index.html`、`tool.html`、`wf.html`（可继续放 GitHub Pages）
- Cloudflare Worker 旧后端：`worker-backend/`（保留，便于回滚）
- 阿里云 Node 后端：`aliyun-backend/`（推荐生产使用）

## 1) 后端（阿里云）快速启动

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
cp aliyun-backend/.env.example aliyun-backend/.env
```

按需修改：
- `PORT`：后端端口（默认 `8788`）
- `WF_DB_PATH`：SQLite 文件路径
- `CORS_ORIGIN` / `WF_CORS_ORIGIN`：允许的前端域名（逗号分隔）
- `WF_COOKIE_SAMESITE` / `WF_COOKIE_SECURE`：登录 Cookie 策略
- `WF_ADMIN_USERNAME`：管理员用户名
- `WF_AI_PROVIDER`：`mock` / `deepseek` / `openai`
- `DEEPSEEK_API_KEY`：DeepSeek Key（翻译与 AI 开头）
- `NETEASE_COOKIE`：网易云登录 Cookie（播放器）

### 初始化数据库

```bash
npm run aliyun:migrate
```

### 本地运行

```bash
npm run aliyun:dev
```

默认监听：`http://127.0.0.1:8788`

## 2) 生产部署（阿里云服务器）

### PM2

部署模板：`aliyun-backend/deploy/pm2.config.cjs`

```bash
mkdir -p aliyun-backend/logs
pm2 start aliyun-backend/deploy/pm2.config.cjs
pm2 save
```

### Nginx 反向代理

参考模板：`aliyun-backend/deploy/nginx.conf.example`

建议将 `api.wanderingfiction.xyz` 反代到 `127.0.0.1:8788`。

## 3) 前端 API 地址

三个页面均支持自动读取以下变量（按顺序）：
1. `window.API_BASE_URL`
2. `window.WF_API_BASE`
3. `localStorage.API_BASE_URL`
4. `localStorage.WF_API_BASE`
5. 默认 `https://api.wanderingfiction.xyz`
6. 本地回退 `http://127.0.0.1:8788`

你可以在浏览器控制台临时切换：

```js
localStorage.setItem('API_BASE_URL', 'https://你的后端域名')
location.reload()
```

## 4) 现有 npm scripts

```bash
npm run aliyun:migrate
npm run aliyun:dev
npm run aliyun:start

npm run worker:dev
npm run worker:deploy
npm run worker:wf:migrate:local
npm run worker:wf:migrate:remote

npm run dev
npm run deploy
```
