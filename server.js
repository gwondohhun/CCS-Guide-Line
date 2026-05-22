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

  console.log('API 요청 받음');

  if (!apiKey) {
    console.error('API 키 없음!');
    return res.status(500).json({ error: 'GEMINI_API_KEY 없음' });
  }

  try {
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { maxOutputTokens: 1200 }
        })
      }
    );

    const data = await response.json();
    console.log('Gemini 응답 상태:', response.status);

    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Gemini API 오류' });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '답변 없음';

    // Anthropic 형식으로 변환해서 반환 (프론트엔드 코드 변경 불필요)
    res.json({
      content: [{ type: 'text', text }]
    });

  } catch (err) {
    console.error('에러:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
