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

// 모델 우선순위 — 과부하 시 다음 모델로 폴백
const MODEL_PRIORITY = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.0-pro',
];

let availableModels = null;
let modelCacheTime = 0;

async function getAvailableModels(apiKey) {
  // 10분마다 모델 목록 갱신
  if (availableModels && Date.now() - modelCacheTime < 600000) return availableModels;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();
    availableModels = (data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
    modelCacheTime = Date.now();
    console.log('[모델 목록]', availableModels.slice(0, 5).join(', '));
  } catch (e) {
    console.warn('[모델 목록 조회 실패]', e.message);
    availableModels = MODEL_PRIORITY; // fallback
  }
  return availableModels;
}

async function tryModel(apiKey, modelName, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000) // 25초 타임아웃
  });
  return { r, data: await r.json() };
}

function isOverloadError(status, msg = '') {
  return status === 503 || status === 429
    || msg.toLowerCase().includes('high demand')
    || msg.toLowerCase().includes('overloaded')
    || msg.toLowerCase().includes('quota')
    || msg.toLowerCase().includes('resource exhausted')
    || msg.toLowerCase().includes('temporarily unavailable');
}

async function callGemini(apiKey, system, userContent) {
  const models = await getAvailableModels(apiKey);

  // 우선순위 순서로 사용 가능한 모델 목록 구성
  const orderedModels = MODEL_PRIORITY.filter(m => models.includes(m));
  if (orderedModels.length === 0) orderedModels.push(models[0]); // 최후 fallback

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: userContent }],
    generationConfig: {
      maxOutputTokens: 4000,
      temperature: 0.3,
      topP: 0.9,
    }
  };

  const MAX_TOTAL_ATTEMPTS = 5;
  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_TOTAL_ATTEMPTS) {
    // 모델 순환: 앞 2번은 첫번째 모델, 과부하 시 다음 모델로 전환
    const modelIdx = Math.min(Math.floor(attempt / 2), orderedModels.length - 1);
    const modelName = orderedModels[modelIdx];

    console.log(`[시도 ${attempt + 1}/${MAX_TOTAL_ATTEMPTS}] 모델: ${modelName}`);

    try {
      const { r, data } = await tryModel(apiKey, modelName, body);

      if (r.ok) {
        const finishReason = data.candidates?.[0]?.finishReason;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (finishReason === 'MAX_TOKENS') console.warn('[경고] MAX_TOKENS 도달');
        console.log(`[성공] 모델: ${modelName} / 길이: ${text.length}`);
        return text || '답변을 생성하지 못했습니다.';
      }

      const errMsg = data.error?.message || `HTTP ${r.status}`;
      console.warn(`[실패] 모델: ${modelName} / ${r.status} / ${errMsg}`);

      if (isOverloadError(r.status, errMsg)) {
        lastError = errMsg;
        // 모델 전환 전 대기: 1.5초, 3초, 4.5초...
        const delay = 1500 * (attempt + 1);
        console.log(`[대기] ${delay}ms 후 재시도 (모델 전환 가능)...`);
        await new Promise(res => setTimeout(res, delay));
        attempt++;
        continue;
      }

      // 과부하 아닌 다른 에러는 바로 throw
      throw new Error(errMsg);

    } catch (e) {
      if (e.name === 'TimeoutError' || e.message.includes('timeout')) {
        console.warn(`[타임아웃] 모델: ${modelName}`);
        lastError = 'timeout';
        attempt++;
        continue;
      }
      if (e.message && !isOverloadError(0, e.message)) throw e;
      lastError = e.message;
      attempt++;
    }
  }

  throw new Error('overload:' + (lastError || '과부하'));
}

app.post('/api/ask', async (req, res) => {
  const { messages, system, image } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY 없음', retryable: false });

  const parts = [];
  if (image?.base64) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  }
  parts.push({ text: messages[0]?.content || '' });

  try {
    const text = await callGemini(apiKey, system, parts);
    res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error('[서버 오류]', err.message);
    const overload = err.message.startsWith('overload:')
      || isOverloadError(0, err.message);

    res.status(overload ? 503 : 500).json({
      error: overload
        ? '잠시 후 다시 시도해주세요.'
        : `오류: ${err.message}`,
      retryable: overload
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중 포트 ${PORT}`));
