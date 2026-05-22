const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/ask', async (req, res) => {
  const { messages, system } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY 없음' });

  const contents = [
    {
      role: 'user',
      parts: [{ text: `[시스템 지시사항]\n${system}\n\n[질문]\n${messages[0].content}` }]
    }
  ];

  // 사용 가능한 모델 목록 먼저 확인 후 첫 번째 모델 사용
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const listData = await listRes.json();
    console.log('사용가능 모델:', JSON.stringify(listData?.models?.map(m => m.name)).slice(0, 500));

    // generateContent 지원 모델 찾기
    const model = listData?.models?.find(m =>
      m.supportedGenerationMethods?.includes('generateContent') &&
      m.name.includes('gemini')
    );

    if (!model) return res.status(500).json({ error: '사용 가능한 Gemini 모델 없음' });

    const modelName = model.name.replace('models/', '');
    console.log('사용 모델:', modelName);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 1200 } })
    });

    const data = await r.json();
    console.log('응답 status:', r.status);
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
