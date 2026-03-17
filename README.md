# OCR + DeepSeek 翻译网页（Pages + 自建 OCR + 独立 Worker）

这个项目支持：
- 上传图片后调用你自建的 PaddleOCR 服务识别文字
- 前端再请求独立 Worker 后端翻译：`https://restless-credit-a6e1.wangderingfiction.workers.dev/api/translate`

## 目录结构

- `index.html`：前端页面（已固定请求你的 Worker 域名）
- `worker-backend/index.js`：Worker 后端逻辑
- `ocr-service/`：自建 PaddleOCR 服务（FastAPI + Docker）
- `wrangler.worker.toml`：Worker 部署配置（名称 `restless-credit-a6e1`）
- `wrangler.toml`：Pages 本地调试配置

## 你现在的部署方式

1. GitHub 仓库 -> Cloudflare Pages（部署前端静态网页）
2. 自建 OCR 服务 -> 作为 OCR API（`/ocr`）
3. 独立 Worker -> 作为翻译 API（`/api/translate`）

## Worker 配置 DeepSeek 密钥

在项目根目录执行：

```bash
npx wrangler secret put DEEPSEEK_API_KEY --config wrangler.worker.toml
```

然后输入你的 DeepSeek API Key。

## 常用命令

```bash
npm install
npm run worker:deploy
npm run deploy
```

## 启动自建 OCR 服务

```bash
cd ocr-service
docker compose up -d --build
```

启动后在页面里把“自建 OCR 服务地址”填成你的服务地址（例如 `http://127.0.0.1:8000`）。

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
