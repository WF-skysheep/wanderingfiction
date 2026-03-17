const path = require("path");
const express = require("express");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname)));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ocr-translate-web" });
});

app.post("/api/translate", async (req, res) => {
  try {
    const { sourceText, targetLanguage, model } = req.body || {};

    if (!sourceText || typeof sourceText !== "string") {
      return res.status(400).json({ error: "sourceText is required" });
    }
    if (!targetLanguage || typeof targetLanguage !== "string") {
      return res.status(400).json({ error: "targetLanguage is required" });
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Server is missing DEEPSEEK_API_KEY. Please configure .env first."
      });
    }

    const selectedModel = typeof model === "string" && model.trim() ? model.trim() : "deepseek-chat";

    const systemPrompt = [
      "你是专业翻译助手。",
      `请将用户提供的文本翻译成：${targetLanguage}。`,
      "要求：",
      "1) 保留原意，不要编造。",
      "2) 保持段落结构。",
      "3) 如果存在明显乱码，尽量基于上下文修复后翻译。",
      "4) 只输出翻译结果，不要附加说明。"
    ].join("\n");

    const upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: sourceText }
        ],
        temperature: 0.2
      })
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `DeepSeek request failed: ${upstream.status}`,
        detail: raw
      });
    }

    const data = JSON.parse(raw);
    const translated = data.choices?.[0]?.message?.content?.trim();

    if (!translated) {
      return res.status(502).json({ error: "No translated text returned by DeepSeek" });
    }

    return res.json({ translatedText: translated, model: selectedModel });
  } catch (error) {
    return res.status(500).json({
      error: "Internal server error",
      detail: error && error.message ? error.message : String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
