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

async function callGemini(apiKey, contents, retries = 3) {
  // 사용 가능한 모델 목록 조회
  const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const listData = await listRes.json();
  const models = listData?.models || [];

  const model = models.find(m =>
    m.supportedGenerationMethods?.includes('generateContent') &&
    m.name.includes('gemini') &&
    !m.name.includes('embedding') &&
    !m.name.includes('aqa')
  );
  if (!model) throw new Error('사용 가능한 모델 없음');

  const modelName = model.name.replace('models/', '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`[시도 ${attempt}/${retries}] 모델: ${modelName}`);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 1500 } })
    });

    const data = await r.json();

    if (r.ok) {
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '답변을 생성하지 못했습니다.';
      console.log(`[성공] 응답 길이: ${text.length}`);
      return text;
    }

    const errMsg = data.error?.message || 'API 오류';
    const isOverload = errMsg.toLowerCase().includes('high demand') || errMsg.toLowerCase().includes('overloaded') || r.status === 503 || r.status === 429;

    console.warn(`[실패 ${attempt}] status: ${r.status} / ${errMsg}`);

    if (isOverload && attempt < retries) {
      const delay = attempt * 2000; // 2초, 4초 대기
      console.log(`[대기] ${delay}ms 후 재시도...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    throw new Error(errMsg);
  }
}

app.post('/api/ask', async (req, res) => {
  const { messages, system, image } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY 없음' });

  let parts = [];
  if (image) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  }
  parts.push({ text: `[시스템 지시사항]\n${system}\n\n[질문]\n${messages[0].content}` });

  const contents = [{ role: 'user', parts }];

  try {
    const text = await callGemini(apiKey, contents, 3);
    res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error('[서버 오류]', err.message);

    // 과부하 오류는 한국어로 안내
    const isOverload = err.message.toLowerCase().includes('high demand') || err.message.toLowerCase().includes('overloaded');
    const clientMsg = isOverload
      ? 'AI 서버가 일시적으로 과부하 상태예요. 잠시 후 다시 시도해주세요.'
      : err.message;

    res.status(500).json({ error: clientMsg });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
