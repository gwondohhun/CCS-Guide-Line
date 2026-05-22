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

app.post('/api/ask', async (req, res) => {
  const { messages, system, image } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY 없음' });

  // 이미지가 있으면 vision 모드
  let parts = [];
  if (image) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  }
  parts.push({ text: `[시스템 지시사항]\n${system}\n\n[질문]\n${messages[0].content}` });

  const contents = [{ role: 'user', parts }];

  try {
    // 사용 가능한 모델 자동 탐색
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const listData = await listRes.json();

    const models = listData?.models || [];
    console.log('전체 모델 수:', models.length);

    // 이미지가 있으면 vision 지원 모델, 없으면 일반 모델
    let model;
    if (image) {
      model = models.find(m =>
        m.supportedGenerationMethods?.includes('generateContent') &&
        m.name.includes('gemini') &&
        !m.name.includes('embedding') &&
        (m.name.includes('flash') || m.name.includes('pro'))
      );
    } else {
      model = models.find(m =>
        m.supportedGenerationMethods?.includes('generateContent') &&
        m.name.includes('gemini') &&
        !m.name.includes('embedding')
      );
    }

    if (!model) {
      console.log('모델 없음, 전체:', JSON.stringify(models.map(m => m.name)));
      return res.status(500).json({ error: '사용 가능한 Gemini 모델 없음' });
    }

    const modelName = model.name.replace('models/', '');
    console.log('사용 모델:', modelName, '이미지:', !!image);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: 1500 }
      })
    });

    const data = await r.json();
    console.log('응답 status:', r.status, JSON.stringify(data).slice(0, 200));

    if (!r.ok) return res.status(500).json({ error: data.error?.message || 'API 오류' });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '답변 없음';
    res.json({ content: [{ type: 'text', text }] });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
