export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "deepseek-worker-backend" }, 200);
    }

    if (request.method === "GET" && url.pathname === "/api/netease/random-song") {
      return handleNeteaseRandomSong(env);
    }

    if (request.method === "GET" && url.pathname === "/api/netease/profile") {
      return handleNeteaseProfile(env);
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
    const model = normalizeModel(body?.model);

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

async function handleNeteaseProfile(env) {
  try {
    const cookie = env.NETEASE_COOKIE;
    if (!cookie) {
      return json({ error: "Missing NETEASE_COOKIE in Worker secrets" }, 500);
    }

    const upstream = await fetch("https://music.163.com/api/nuser/account/get", {
      method: "GET",
      headers: neteaseHeaders(cookie),
    });

    const data = await parseJsonSafe(await upstream.text());
    if (!upstream.ok || !data || data.code !== 200) {
      return json(
        {
          error: "Failed to verify NetEase login profile",
          detail: data || { status: upstream.status },
        },
        502
      );
    }

    return json(
      {
        userId: data?.profile?.userId ?? null,
        nickname: data?.profile?.nickname ?? null,
      },
      200
    );
  } catch (error) {
    return json(
      { error: "NetEase profile request failed", detail: error?.message || String(error) },
      500
    );
  }
}

async function handleNeteaseRandomSong(env) {
  try {
    const cookie = env.NETEASE_COOKIE;
    if (!cookie) {
      return json({ error: "Missing NETEASE_COOKIE in Worker secrets" }, 500);
    }

    const upstream = await fetch("https://music.163.com/api/v1/discovery/recommend/songs", {
      method: "GET",
      headers: neteaseHeaders(cookie),
    });

    const data = await parseJsonSafe(await upstream.text());
    const list = Array.isArray(data?.recommend) ? data.recommend : [];
    if (!upstream.ok || data?.code !== 200 || list.length === 0) {
      return json(
        {
          error: "Failed to fetch recommended songs from NetEase",
          detail: data || { status: upstream.status },
        },
        502
      );
    }

    const selected = list[Math.floor(Math.random() * list.length)];
    const songId = selected?.id;
    if (!songId) {
      return json({ error: "Invalid song item returned by NetEase" }, 502);
    }

    const streamUrl = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
    const artists = Array.isArray(selected?.artists)
      ? selected.artists.map((a) => a?.name).filter(Boolean)
      : [];

    return json(
      {
        id: songId,
        name: selected?.name || "未知歌曲",
        artists,
        coverUrl: selected?.album?.picUrl || "",
        reason: selected?.reason || "随机推荐",
        streamUrl,
      },
      200
    );
  } catch (error) {
    return json(
      { error: "NetEase random recommendation request failed", detail: error?.message || String(error) },
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

function neteaseHeaders(cookie) {
  return {
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://music.163.com/",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Cookie": cookie,
  };
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeModel(input) {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!raw) return "deepseek-chat";
  if (raw === "chat" || raw === "deepseek-chat") return "deepseek-chat";
  if (raw === "reasoner" || raw === "resoner" || raw === "deepseek-reasoner") return "deepseek-reasoner";
  return "deepseek-chat";
}
