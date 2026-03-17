# OCR + DeepSeek 翻译网页（Pages + 独立 Worker）

这个项目支持：
- 上传图片并使用浏览器端 OCR 识别文字（无需部署）
- 前端再请求独立 Worker 后端翻译：`https://restless-credit-a6e1.wangderingfiction.workers.dev/api/translate`

## 目录结构

- `index.html`：前端页面（已固定请求你的 Worker 域名）
- `worker-backend/index.js`：Worker 后端逻辑
- `wrangler.worker.toml`：Worker 部署配置（名称 `restless-credit-a6e1`）
- `wrangler.toml`：Pages 本地调试配置

## 你现在的部署方式

1. GitHub 仓库 -> Cloudflare Pages（部署前端静态网页）
2. 独立 Worker -> 作为翻译 API（`/api/translate`）

## Worker 配置 DeepSeek 密钥

在项目根目录执行：

```bash
npx wrangler secret put DEEPSEEK_API_KEY --config wrangler.worker.toml
```

然后输入你的 DeepSeek API Key。

## Worker 配置网易云登录态（主页播放器）

主页随机推荐播放器依赖后端网易云登录态，请再配置：

```bash
npx wrangler secret put NETEASE_COOKIE --config wrangler.worker.toml
```

把你网易云登录后的完整 Cookie 字符串填进去（仅存储在 Worker Secret，不暴露给前端）。

## 常用命令

```bash
npm install
npm run worker:deploy
npm run deploy
```

## 本地调试（可选）

1. 创建本地变量文件：

```bash
cp .dev.vars.example .dev.vars
```

2. 写入：

```bash
DEEPSEEK_API_KEY=你的key
```

3. 本地运行 Worker：

```bash
npm run worker:dev
```

## 注意

- 不要把 `.dev.vars` 提交到仓库。
- API Key 只应放在 Worker Secret，不要放前端。
