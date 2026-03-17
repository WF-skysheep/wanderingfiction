function pickMockOpening(projectName) {
  const seeds = [
    '雨夜里，' + projectName + ' 的第一盏灯突然亮起。',
    '没有人知道 ' + projectName + ' 从哪一天开始被传颂。',
    projectName + ' 的故事，要从一封未署名的信说起。',
    '当城市最后一班车离站时，' + projectName + ' 才真正开始。',
  ];
  return seeds[Math.floor(Math.random() * seeds.length)];
}

async function callDeepSeek(apiKey, projectName) {
  const prompt = '请生成一个中文小说开头，80-160字，题目主题为“' + projectName + '”，风格有画面感。只输出正文。';
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0.9,
      messages: [
        { role: 'system', content: '你是小说写作助手。' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error('DeepSeek failed: ' + res.status + ' ' + detail.slice(0, 300));
  }
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    ? String(data.choices[0].message.content).trim()
    : '';
  if (!text) throw new Error('DeepSeek empty response');
  return text;
}

async function callOpenAI(apiKey, projectName) {
  const prompt = '请生成一个中文小说开头，80-160字，题目主题为“' + projectName + '”，只输出正文。';
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: '你是小说写作助手。' },
        { role: 'user', content: prompt },
      ],
      max_output_tokens: 220,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error('OpenAI failed: ' + res.status + ' ' + detail.slice(0, 300));
  }
  const data = await res.json();
  const out = data && data.output_text ? String(data.output_text).trim() : '';
  if (!out) throw new Error('OpenAI empty response');
  return out;
}

function createAIProvider(env) {
  const runtimeEnv = env || process.env;
  const providerName = String(runtimeEnv.WF_AI_PROVIDER || 'mock').toLowerCase();

  return {
    name: providerName,
    async generateOpening(projectName) {
      const safeName = String(projectName || '流浪小说').trim() || '流浪小说';
      try {
        if (providerName === 'deepseek' && runtimeEnv.DEEPSEEK_API_KEY) {
          return await callDeepSeek(runtimeEnv.DEEPSEEK_API_KEY, safeName);
        }
        if (providerName === 'openai' && runtimeEnv.OPENAI_API_KEY) {
          return await callOpenAI(runtimeEnv.OPENAI_API_KEY, safeName);
        }
      } catch (error) {
        console.error('[WF AI] provider failed, fallback to mock:', error.message);
      }
      return pickMockOpening(safeName);
    },
  };
}

module.exports = { createAIProvider };
