# OCR + DeepSeek 翻译网页

这个项目支持：
- 上传图片并使用 Tesseract.js 做 OCR（前端）
- 调用后端接口，用 DeepSeek API 翻译识别文字

## 本地运行

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

然后编辑 `.env`，填入你的 `DEEPSEEK_API_KEY`。

3. 启动服务

```bash
npm start
```

4. 打开浏览器

访问 <http://localhost:3000>

## 注意

- 不要把 `.env` 提交到仓库。
- 如果你要部署到线上，请在部署平台配置 `DEEPSEEK_API_KEY` 环境变量。
