# OCR + DeepSeek 翻译网页（Cloudflare Pages）

这个项目支持：
- 上传图片并使用 Tesseract.js 做 OCR（前端）
- 通过 Cloudflare Pages Functions 调用 DeepSeek API 进行翻译

## 目录结构

- `index.html`：前端页面
- `functions/api/translate.js`：Cloudflare Functions 后端接口
- `wrangler.toml`：Cloudflare 本地开发配置

## Cloudflare 部署（连接 GitHub）

1. Cloudflare Dashboard -> Pages -> `Create a project`，选择你的 GitHub 仓库。
2. 构建设置：
   - Framework preset: `None`
   - Build command: 留空
   - Build output directory: `.`
3. 在该 Pages 项目中设置环境变量：
   - `DEEPSEEK_API_KEY` = 你的 DeepSeek Key
4. 触发部署后访问站点，即可使用 `/api/translate`（由 Functions 提供）。

## 本地调试（可选）

1. 安装依赖

```bash
npm install
```

2. 配置本地密钥

```bash
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，填入 `DEEPSEEK_API_KEY`。

3. 本地启动

```bash
npm run dev
```

默认访问本地地址（wrangler 输出的 URL）。

## 注意

- 不要把 `.dev.vars` 提交到仓库。
- 前端不再存储 API Key，密钥仅在 Cloudflare Functions 环境变量中使用。
