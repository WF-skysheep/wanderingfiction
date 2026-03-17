export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => null);
    const sourceText = body?.sourceText;
    const targetLanguage = body?.targetLanguage;
    const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : "deepseek-chat";

    if (!sourceText || typeof sourceText !== "string") {
      return json({ error: "sourceText is required" }, 400);
    }
    if (!targetLanguage || typeof targetLanguage !== "string") {
      return json({ error: "targetLanguage is required" }, 400);
    }

    const apiKey = context.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return json({ error: "Missing DEEPSEEK_API_KEY in Cloudflare environment variables" }, 500);
    }

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
    const translated = data?.choices?.[0]?.message?.content?.trim();

    if (!translated) {
      return json({ error: "No translated text returned by DeepSeek" }, 502);
    }

    return json({ translatedText: translated, model });
  } catch (error) {
    return json(
      { error: "Internal server error", detail: error && error.message ? error.message : String(error) },
      500
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
