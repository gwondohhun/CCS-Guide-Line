const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 모델 우선순위: 최신/고성능 순
const MODEL_PRIORITY = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-1.0-pro',
];

let cachedModel = null;

async function getBestModel(apiKey) {
  if (cachedModel) return cachedModel;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const data = await res.json();
  const available = (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => m.name.replace('models/', ''));

  for (const preferred of MODEL_PRIORITY) {
    if (available.includes(preferred)) {
      cachedModel = preferred;
      console.log(`[모델 선택] ${preferred}`);
      return preferred;
    }
  }
  // fallback: 첫번째 사용 가능 모델
  cachedModel = available[0];
  return cachedModel;
}

async function callGemini(apiKey, system, userContent, retries = 3) {
  const modelName = await getBestModel(apiKey);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: userContent }],
    generationConfig: {
      maxOutputTokens: 4000,   // 끊김 방지: 1500 → 4000
      temperature: 0.3,        // 일관성 있는 답변
      topP: 0.9,
    }
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`[시도 ${attempt}/${retries}] 모델: ${modelName}`);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const result = await r.json();

    if (r.ok) {
      // 응답 끊김 여부 확인
      const finishReason = result.candidates?.[0]?.finishReason;
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log(`[성공] finishReason: ${finishReason} / 길이: ${text.length}`);

      if (finishReason === 'MAX_TOKENS') {
        console.warn('[경고] MAX_TOKENS 도달 — 응답이 잘릴 수 있음');
      }
      return text || '답변을 생성하지 못했습니다.';
    }

    const errMsg = result.error?.message || 'API 오류';
    const isOverload = r.status === 503 || r.status === 429
      || errMsg.toLowerCase().includes('high demand')
      || errMsg.toLowerCase().includes('overloaded')
      || errMsg.toLowerCase().includes('quota');

    console.warn(`[실패 ${attempt}] ${r.status} / ${errMsg}`);

    if (isOverload && attempt < retries) {
      const delay = attempt * 2500;
      console.log(`[대기] ${delay}ms 후 재시도...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    throw new Error(errMsg);
  }
}

app.post('/api/ask', async (req, res) => {
  const { messages, system, image } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY 없음' });

  // 이미지 + 텍스트 분리
  const parts = [];
  if (image?.base64) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  }
  parts.push({ text: messages[0]?.content || '' });

  try {
    const text = await callGemini(apiKey, system, parts, 3);
    res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error('[서버 오류]', err.message);
    const isOverload = ['high demand', 'overloaded', 'quota', '429', '503']
      .some(k => err.message.toLowerCase().includes(k));
    res.status(500).json({
      error: isOverload
        ? 'AI 서버가 일시적으로 과부하 상태예요. 잠시 후 다시 시도해주세요.'
        : `오류: ${err.message}`
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중 포트 ${PORT}`));
