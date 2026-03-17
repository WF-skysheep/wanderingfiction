export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "deepseek-worker-backend" }, 200);
    }

    if (request.method === "POST" && url.pathname === "/api/translate") {
      return handleTranslate(request, env);
    }

    return json({ error: "Not Found" }, 404);
  }
};

async function handleTranslate(request, env) {
  try {
    const body = await request.json().catch(() => null);
    const sourceText = body?.sourceText;
    const targetLanguage = body?.targetLanguage;
    const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : "deepseek-chat";

    if (!sourceText || typeof sourceText !== "string") {
      return json({ error: "sourceText is required" }, 400);
    }
    if (!targetLanguage || typeof targetLanguage !== "string") {
      return json({ error: "targetLanguage is required" }, 400);
    }

    if (!env.DEEPSEEK_API_KEY) {
      return json({ error: "Missing DEEPSEEK_API_KEY in Worker secrets" }, 500);
    }

    const systemPrompt = [
      "你是专业翻译助手。",
      `请先识别用户文本的原始语言，再翻译为：${targetLanguage}。`,
      "请严格只输出 JSON，不要输出任何多余文本。",
      "JSON 格式必须是：",
      "{\"source_language\":\"<检测到的语言>\",\"translated_text\":\"<翻译结果>\"}",
      "要求：",
      "1) 保留原意，不要编造。",
      "2) 保持段落结构。",
      "3) 如果存在明显乱码，尽量基于上下文修复后翻译。"
    ].join("\n");

    const upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: sourceText }
        ],
        temperature: 0.2
      })
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      return json({ error: `DeepSeek request failed: ${upstream.status}`, detail: raw }, upstream.status);
    }

    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return json({ error: "No translated content returned by DeepSeek" }, 502);
    }

    const parsed = parseTranslationPayload(content);
    return json(
      {
        translatedText: parsed.translatedText,
        sourceLanguage: parsed.sourceLanguage,
        model
      },
      200
    );
  } catch (error) {
    return json(
      { error: "Internal server error", detail: error && error.message ? error.message : String(error) },
      500
    );
  }
}

function parseTranslationPayload(content) {
  const direct = tryParseJson(content);
  if (direct) return normalizeResult(direct, content);

  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    const extracted = tryParseJson(match[0]);
    if (extracted) return normalizeResult(extracted, content);
  }

  return {
    sourceLanguage: "未知",
    translatedText: content
  };
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeResult(parsed, fallbackText) {
  const sourceLanguage =
    (typeof parsed.source_language === "string" && parsed.source_language.trim()) ||
    (typeof parsed.sourceLanguage === "string" && parsed.sourceLanguage.trim()) ||
    "未知";

  const translatedText =
    (typeof parsed.translated_text === "string" && parsed.translated_text.trim()) ||
    (typeof parsed.translatedText === "string" && parsed.translatedText.trim()) ||
    fallbackText;

  return { sourceLanguage, translatedText };
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
