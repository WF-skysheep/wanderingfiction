# Self-hosted PaddleOCR Service

## 1. 启动服务（Docker）

```bash
cd ocr-service
docker compose up -d --build
```

服务地址：`http://127.0.0.1:8000`

## 2. 健康检查

```bash
curl http://127.0.0.1:8000/health
```

## 3. OCR 测试

```bash
curl -X POST "http://127.0.0.1:8000/ocr" \
  -F "file=@/path/to/your-image.png" \
  -F "lang_profile=multi"
```

## `lang_profile` 可选值

- `multi` 自动多语言（默认）
- `ch` 中文（简体 + 英文）
- `chinese_cht` 中文（繁体）
- `en` 英语
- `japan` 日语
- `korean` 韩语
- `french` 法语
- `german` 德语

## 说明

- 这是自建 OCR 服务，前端会调用 `/ocr` 并拿回文本。
- 首次启动会下载模型，耗时会更长。
