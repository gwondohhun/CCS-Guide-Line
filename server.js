const express = require('express');
const cors    = require('cors');
const path    = require('path');
const app     = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── 모델 우선순위 (하드코딩 — 모델 목록 API 호출 제거) ──
// 실제 존재하는 모델명 고정 (모델 목록 조회 비용/지연 제거)
// 모델 우선순위 — v1beta streamGenerateContent 지원 확인된 모델만
const MODELS = [
  'gemini-2.0-flash',           // 최신, 빠름 — 1순위
  'gemini-1.5-flash-latest',    // 안정적 fallback (gemini-1.5-flash 대신 latest 사용)
  'gemini-1.5-pro-latest',      // 최후 fallback
];

function isOverload(status, msg = '') {
  return status === 429 || status === 503
    || /overload|high demand|quota|resource.?exhaust|unavailable/i.test(msg);
}

// ── 스트리밍 Gemini 호출 ──
// SSE(Server-Sent Events) 방식으로 토큰 단위 스트리밍
async function streamGemini(apiKey, system, parts, res) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents:          [{ role: 'user', parts }],
    generationConfig:  { maxOutputTokens: 4000, temperature: 0.3, topP: 0.9 },
  };

  // SSE 헤더
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx 버퍼 비활성화

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let lastErr = null;
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const r = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(30000),
      });

      if (!r.ok) {
        const errData = await r.json().catch(() => ({}));
        const msg = errData.error?.message || `HTTP ${r.status}`;
        if (isOverload(r.status, msg) && i < MODELS.length - 1) {
          console.warn(`[${model}] 과부하 → 다음 모델 전환`);
          continue; // 다음 모델 즉시 시도 (대기 없음)
        }
        send({ error: msg, retryable: isOverload(r.status, msg) });
        res.end();
        return;
      }

      // SSE 스트림 파싱
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let tokenCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // 미완성 줄은 버퍼에 보관

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') continue;
          try {
            const chunk = JSON.parse(raw);
            const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              send({ token: text });
              tokenCount++;
            }
            const finish = chunk.candidates?.[0]?.finishReason;
            if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
              console.warn(`[${model}] finishReason: ${finish}`);
            }
          } catch {}
        }
      }

      send({ done: true, model, tokens: tokenCount });
      res.end();
      return;

    } catch (e) {
      lastErr = e.message;
      if (e.name === 'TimeoutError') {
        console.warn(`[${model}] 타임아웃 → 다음 모델 전환`);
        continue;
      }
      if (isOverload(0, e.message) && i < MODELS.length - 1) continue;
      break;
    }
  }

  send({ error: '모든 모델 호출 실패. 잠시 후 다시 시도해주세요.', retryable: true });
  res.end();
}

// ── /api/ask ──────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const { messages, system, image } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.write(`data: ${JSON.stringify({ error: 'GEMINI_API_KEY 없음', retryable: false })}\n\n`);
    return res.end();
  }

  const parts = [];
  if (image?.base64) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  }
  parts.push({ text: messages?.[0]?.content || '' });

  await streamGemini(apiKey, system || '', parts, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 포트 ${PORT}`));
