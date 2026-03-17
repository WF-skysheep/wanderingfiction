const path = require('path');
const { createApp } = require('./wf-app');
const { openDatabase, runMigrations } = require('./db');
const { createAIProvider } = require('./ai-provider');

const PORT = Number(process.env.PORT || process.env.ALIYUN_API_PORT || 8788);
const DB_PATH = process.env.WF_DB_PATH || path.join(process.cwd(), 'aliyun-backend', 'data', 'wf.db');
const CORS_ORIGIN = process.env.CORS_ORIGIN || process.env.WF_CORS_ORIGIN || '*';

const db = openDatabase(DB_PATH);
runMigrations(db);

const app = createApp({
  db,
  aiProvider: createAIProvider(process.env),
  corsOrigin: CORS_ORIGIN === '*' ? '' : CORS_ORIGIN,
});

app.use((req, res, next) => {
  const reqOrigin = req.headers.origin || '';
  const allowList = String(CORS_ORIGIN || '*').split(',').map((x) => x.trim()).filter(Boolean);

  let allowOrigin = '*';
  if (allowList.length && allowList[0] !== '*') {
    allowOrigin = allowList.includes(reqOrigin) ? reqOrigin : allowList[0];
  } else if (reqOrigin) {
    allowOrigin = reqOrigin;
  }

  res.header('Access-Control-Allow-Origin', allowOrigin);
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'aliyun-backend', wf: true, ocr: true, netease: true });
});

app.post('/api/translate', async (req, res) => {
  try {
    const sourceText = req.body?.sourceText;
    const targetLanguage = req.body?.targetLanguage;
    const model = normalizeModel(req.body?.model);

    if (!sourceText || typeof sourceText !== 'string') {
      return res.status(400).json({ error: 'sourceText is required' });
    }
    if (!targetLanguage || typeof targetLanguage !== 'string') {
      return res.status(400).json({ error: 'targetLanguage is required' });
    }
    if (!process.env.DEEPSEEK_API_KEY) {
      return res.status(500).json({ error: 'Missing DEEPSEEK_API_KEY' });
    }

    const systemPrompt = [
      '你是专业翻译助手。',
      `请先识别用户文本的原始语言，再翻译为：${targetLanguage}。`,
      '请严格只输出 JSON，不要输出任何多余文本。',
      '{"source_language":"<检测到的语言>","translated_text":"<翻译结果>"}',
    ].join('\n');

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: sourceText },
        ],
        temperature: 0.2,
      }),
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `DeepSeek request failed: ${upstream.status}`, detail: raw });
    }

    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return res.status(502).json({ error: 'No translated content returned by DeepSeek' });

    const parsed = parseTranslationPayload(content);
    return res.json({ translatedText: parsed.translatedText, sourceLanguage: parsed.sourceLanguage, model });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error', detail: String(error?.message || error) });
  }
});

app.get('/api/netease/profile', async (_req, res) => {
  try {
    const cookie = process.env.NETEASE_COOKIE;
    if (!cookie) return res.status(500).json({ error: 'Missing NETEASE_COOKIE' });

    const upstream = await fetch('https://music.163.com/api/nuser/account/get', {
      method: 'GET',
      headers: neteaseHeaders(cookie),
    });

    const data = await parseJsonSafe(await upstream.text());
    if (!upstream.ok || !data || data.code !== 200) {
      return res.status(502).json({ error: 'Failed to verify NetEase login profile', detail: data || { status: upstream.status } });
    }

    return res.json({ userId: data?.profile?.userId ?? null, nickname: data?.profile?.nickname ?? null });
  } catch (error) {
    return res.status(500).json({ error: 'NetEase profile request failed', detail: String(error?.message || error) });
  }
});

app.get('/api/netease/random-song', async (_req, res) => {
  try {
    const cookie = process.env.NETEASE_COOKIE;
    if (!cookie) return res.status(500).json({ error: 'Missing NETEASE_COOKIE' });

    const upstream = await fetch('https://music.163.com/api/v1/discovery/recommend/songs', {
      method: 'GET',
      headers: neteaseHeaders(cookie),
    });

    const data = await parseJsonSafe(await upstream.text());
    const list = Array.isArray(data?.recommend) ? data.recommend : [];
    if (!upstream.ok || data?.code !== 200 || list.length === 0) {
      return res.status(502).json({ error: 'Failed to fetch recommended songs from NetEase', detail: data || { status: upstream.status } });
    }

    const shuffled = [...list].sort(() => Math.random() - 0.5);
    const csrfToken = extractCsrfToken(cookie);

    for (const selected of shuffled.slice(0, 8)) {
      const songId = selected?.id;
      if (!songId) continue;
      const streamUrl = await fetchNeteasePlayableUrl(songId, cookie, csrfToken);
      if (!streamUrl) continue;

      const artists = Array.isArray(selected?.artists)
        ? selected.artists.map((a) => a?.name).filter(Boolean)
        : [];

      return res.json({
        id: songId,
        name: selected?.name || '未知歌曲',
        artists,
        coverUrl: selected?.album?.picUrl || '',
        reason: selected?.reason || '随机推荐',
        streamUrl,
      });
    }

    return res.status(502).json({ error: 'No playable song found in current recommendations' });
  } catch (error) {
    return res.status(500).json({ error: 'NetEase random recommendation request failed', detail: String(error?.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`[ALIYUN BACKEND] running on http://0.0.0.0:${PORT}`);
  console.log(`[ALIYUN BACKEND] db: ${DB_PATH}`);
});

function parseTranslationPayload(content) {
  const direct = tryParseJson(content);
  if (direct) return normalizeResult(direct, content);

  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    const extracted = tryParseJson(match[0]);
    if (extracted) return normalizeResult(extracted, content);
  }

  return { sourceLanguage: '未知', translatedText: content };
}

function tryParseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeResult(parsed, fallbackText) {
  const sourceLanguage =
    (typeof parsed.source_language === 'string' && parsed.source_language.trim()) ||
    (typeof parsed.sourceLanguage === 'string' && parsed.sourceLanguage.trim()) ||
    '未知';

  const translatedText =
    (typeof parsed.translated_text === 'string' && parsed.translated_text.trim()) ||
    (typeof parsed.translatedText === 'string' && parsed.translatedText.trim()) ||
    fallbackText;

  return { sourceLanguage, translatedText };
}

function neteaseHeaders(cookie) {
  return {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://music.163.com/',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    Cookie: cookie,
  };
}

function parseJsonSafe(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function extractCsrfToken(cookie) {
  const match = cookie.match(/(?:^|;\s*)__csrf=([^;]+)/);
  return match ? match[1] : '';
}

function normalizeModel(input) {
  const raw = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!raw) return 'deepseek-chat';
  if (raw === 'chat' || raw === 'deepseek-chat') return 'deepseek-chat';
  if (raw === 'reasoner' || raw === 'resoner' || raw === 'deepseek-reasoner') return 'deepseek-reasoner';
  return 'deepseek-chat';
}

async function fetchNeteasePlayableUrl(songId, cookie, csrfToken) {
  const endpoint = `https://music.163.com/api/song/enhance/player/url/v1?csrf_token=${encodeURIComponent(csrfToken)}`;
  const body = new URLSearchParams({
    ids: JSON.stringify([songId]),
    level: 'standard',
    encodeType: 'mp3',
  }).toString();

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...neteaseHeaders(cookie),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await parseJsonSafe(await upstream.text());
  const url = data?.data?.[0]?.url;
  return typeof url === 'string' && url.startsWith('http') ? url : '';
}
