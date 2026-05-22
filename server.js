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

  // system 프롬프트를 첫 번째 user 메시지에 합쳐서 전달
  const contents = [
    {
      role: 'user',
      parts: [{ text: `[시스템 지시사항]\n${system}\n\n[질문]\n${messages[0].content}` }]
    }
  ];

  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: 1200 }
      })
    });

    const data = await r.json();
    console.log('status:', r.status, JSON.stringify(data).slice(0, 300));

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
