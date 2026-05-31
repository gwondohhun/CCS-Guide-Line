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
const MODELS = [
  'gemini-2.0-flash-lite',   // 가장 빠름, 먼저 시도
  'gemini-2.0-flash',        // 중간
  'gemini-1.5-flash',        // 안정적 fallback
  'gemini-1.5-flash-8b',     // 경량
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

// ── Drive 파일 카탈로그 ──
const FILE_CATALOG = [
  { id:'1CwC3qRbEErVeVsrmUrYz4ZEb-76m45MC4Of5rwXdzxI', title:'mri101(eng)_250702', folder:'Root',
    desc:'Clinical MRI 101 교육자료. MRI 안전, 하드웨어, K-Space, PAT/GRAPPA/SENSE, SNR, ETL/ETD, 시퀀스 종류, 제조사별 차이점 등 기초 개념 총망라.' },
  { id:'1EZmvBVmjSkOQo3--WfibT-XLNTcxqbj1r6n-iq2stoM', title:'mri101(eng)_250521', folder:'Root',
    desc:'Clinical MRI 101 이전 버전. MRI 원리, DICOM, PACS, 재구성 과정, 제조사 콘솔 버전 소개.' },
  { id:'1Efuj5hTDZsVAnwxyS8oOtY41UWZC8vCn', title:'Canon Apps Training', folder:'Root',
    desc:'Canon/Toshiba MRI 교육자료. 장비 운용, 파라미터 설정, 시퀀스 구성, 임상 적용.' },
  { id:'1eY-Zif_llHXRP4K-NWbVgbkVGoK_PvSZ', title:'(GE) User_CV_FSE', folder:'GE',
    desc:'GE FSE 시퀀스. ETL, TE, TR, bandwidth, echo spacing, NEX, fat sat 옵션.' },
  { id:'15P_CbkVPgk52DiQVxNFOiHMOboT-gTPN', title:'(GE) User_CV_SSFSE_CUBE_EPI', folder:'GE',
    desc:'GE SSFSE, CUBE, EPI 시퀀스. Single-shot FSE, 3D CUBE, EPI DWI 파라미터.' },
  { id:'1Xvj-EmlP0kC2pgWXfDBlP4lh7nCyixlV', title:'(GE) User_CV_GRE', folder:'GE',
    desc:'GE GRE 시퀀스. SPGR, FGRE, FIESTA, mFFE 파라미터, FA, TE, TR 설정.' },
  { id:'1VVxUHUh3gDkbXsEDZ4Nyz3dT7vLWS2Ox', title:'(GE) CASE Study-2013', folder:'GE',
    desc:'GE MRI 케이스 스터디. 임상 artifact 사례, 원인 분석, 해결. Brain/Spine/MSK 케이스.' },
  { id:'1GWhHJpp3tb-s13XSrvRnIlpmxPuUr6c7', title:'(GE) 750W Hardware', folder:'GE',
    desc:'GE Discovery MR750w 하드웨어 매뉴얼. 코일 종류, 그라디언트 스펙.' },
  { id:'1PLbaVScqOkh96OT1saJyeVVE1HG0JFvk', title:'GE 1.5T Signa Operator Manual', folder:'GE',
    desc:'GE Signa 1.5T 운영자 매뉴얼. 스캔 프로토콜, 코일 설치, 트러블슈팅, ARC/ASSET.' },
  { id:'1_b5Px-0fcaOGUPJg0qPmyuBmLxPTuQo7', title:'(Siemens) magnets_spins_and_resonances', folder:'Siemens',
    desc:'Siemens MRI 원리. 자기장, 스핀, 공명, T1/T2 relaxation, k-space, 시퀀스 기초.' },
  { id:'17WuqmYQ2fNRznFFE_pmfwVgjotghPZce', title:'(Siemens) mri_glossary', folder:'Siemens',
    desc:'Siemens MRI 용어집. GRAPPA, TurboFactor, TI, PAT, Restore, iPAT 등 용어 정의.' },
  { id:'1kv_vQkfxz2FkSeHAqLg9a0q7gPSltMnN', title:'(Siemens) mri_acronyms', folder:'Siemens',
    desc:'Siemens MRI 약어집. 파라미터 약어와 명칭 전체 정리.' },
  { id:'1msKARNe5ORh3V6P3bBt_YuM14UUxu7EC', title:'(Siemens) magnets_flows_and_artifacts', folder:'Siemens',
    desc:'Siemens artifact 교재. 혈류, Gibbs, Ghosting, Chemical shift, Wraparound, B0 불균일 원인과 해결.' },
  { id:'1r0ozWfJ5VSs2qK9TniV80W5djoLd3PTi', title:'(Siemens) Syngo', folder:'Siemens',
    desc:'Siemens Syngo 소프트웨어. VB/VD/VE/XA 버전별 UI 차이, 파라미터 설정.' },
  { id:'1s1Xq_br9_vmCX9VHxWKgd4d5rPlWZyPV', title:'Brain Anatomy', folder:'General',
    desc:'뇌 해부학. 뇌 구조, 각 영역 기능, MRI landmark, 신경 경로.' },
  { id:'19d_IRti1vo7cgie2371qUT9ZB6vzxXlE', title:'Gross Anatomy of the Brain', folder:'General',
    desc:'뇌 대해부학. 뇌간, 소뇌, 대뇌, 변연계 등 뇌 전체 구조.' },
  { id:'1U2QEBJh6KvQcs9KX2OPFH-ibtBp5s_Tb', title:'Parameter 정리(권도훈)', folder:'Philips',
    desc:'Philips MRI 파라미터 정리. SENSE factor, mDIXON, Drive, Echo spacing, Scan percentage 등.' },
  { id:'1Pm_EU9uxnVdUtlc3f1DcOsHGHSyd3rVb', title:'IFU_p6i_int_pnl(Korean)', folder:'Philips',
    desc:'Philips 인터페이스 패널 한국어 설명서. 장비 조작, 코일 연결, 오류 대응.' },
  { id:'1zxsNbHeosbJRfwCJUsX7FKYQxzOOgCWk', title:'Ingenia iRF coil information', folder:'Philips',
    desc:'Philips Ingenia iRF 코일. 코일 종류, 연결 방법, SENSE factor 설정.' },
];

// Drive 파일 텍스트 캐시 (6시간)
const driveCache = new Map();
async function getDriveText(fileId, token) {
  const cached = driveCache.get(fileId);
  if (cached && Date.now() - cached.ts < 6*3600*1000) return cached.text;
  if (!token) return FILE_CATALOG.find(f=>f.id===fileId)?.desc || '';
  try {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
    );
    const text = r.ok ? (await r.text()).slice(0, 12000) : FILE_CATALOG.find(f=>f.id===fileId)?.desc || '';
    driveCache.set(fileId, { text, ts: Date.now() });
    return text;
  } catch {
    return FILE_CATALOG.find(f=>f.id===fileId)?.desc || '';
  }
}

function pickFiles(query, max = 3) {
  const q = query.toLowerCase();
  return FILE_CATALOG
    .map(f => {
      let s = 0;
      const hay = `${f.title} ${f.desc} ${f.folder}`.toLowerCase();
      q.split(/\s+/).filter(w=>w.length>1).forEach(w => { if (hay.includes(w)) s += 2; });
      if (q.includes('siemens')   && f.folder==='Siemens') s += 5;
      if (/^ge\b/.test(q)         && f.folder==='GE')      s += 5;
      if (q.includes('philips')   && f.folder==='Philips') s += 5;
      if (q.includes('canon')     && f.title.includes('Canon')) s += 5;
      if (/artifact|아티팩트/.test(q) && hay.includes('artifact')) s += 4;
      if (/파라미터|parameter/.test(q) && hay.includes('파라미터'))  s += 4;
      if (/해부|anatomy/.test(q)  && hay.includes('해부'))  s += 4;
      if (/용어|glossary|acronym/.test(q) && /용어|약어/.test(hay)) s += 4;
      if (/케이스|case\s*study/.test(q) && hay.includes('케이스')) s += 4;
      return { ...f, s };
    })
    .sort((a,b) => b.s - a.s)
    .slice(0, max);
}

// ── /api/ask — SSE 스트리밍 ──
app.post('/api/ask', async (req, res) => {
  const { messages, system, image } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ error:'GEMINI_API_KEY 없음', retryable:false })}\n\n`);
    return res.end();
  }
  const parts = [];
  if (image?.base64) parts.push({ inline_data:{ mime_type:image.mimeType, data:image.base64 }});
  parts.push({ text: messages[0]?.content || '' });
  await streamGemini(apiKey, system, parts, res);
});

// ── /api/drive-search — SSE 스트리밍 ──
app.post('/api/drive-search', async (req, res) => {
  const { query } = req.body;
  const apiKey     = process.env.GEMINI_API_KEY;
  const driveToken = process.env.GOOGLE_ACCESS_TOKEN;

  if (!apiKey) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ error:'GEMINI_API_KEY 없음' })}\n\n`);
    return res.end();
  }

  const files = pickFiles(query, 3);
  console.log(`[Drive] "${query}" → ${files.map(f=>f.title).join(', ')}`);

  // 파일 내용 병렬 로드
  const contents = await Promise.all(files.map(f => getDriveText(f.id, driveToken)));
  const docBlock  = files.map((f,i) => `## [${f.folder}] ${f.title}\n${contents[i]}`).join('\n\n---\n\n');

  const system =
`당신은 AiRSMed CCS팀 MRI 전문 검색 AI입니다.
아래 Google Drive 소스 문서를 근거로 답변하세요.
- 출처는 [파일명] 형태로 표시
- 문서에 없는 내용은 "소스에 정보 없음"으로 안내
- 한국어, 간결하고 구조적으로

${docBlock}`;

  // SSE 헤더 설정 후 스트리밍
  const parts = [{ text: query }];
  const r = await streamGeminiWithSources(process.env.GEMINI_API_KEY, system, parts, res, files);
});

// drive-search용 — sources 포함 스트리밍
async function streamGeminiWithSources(apiKey, system, parts, res, sources) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents:          [{ role: 'user', parts }],
    generationConfig:  { maxOutputTokens: 3000, temperature: 0.3, topP: 0.9 },
  };

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const r = await fetch(url, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });

      if (!r.ok) {
        const errData = await r.json().catch(()=>({}));
        const msg = errData.error?.message || `HTTP ${r.status}`;
        if (isOverload(r.status, msg) && i < MODELS.length-1) continue;
        send({ error: msg, retryable: isOverload(r.status, msg) });
        return res.end();
      }

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream:true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') continue;
          try {
            const chunk = JSON.parse(raw);
            const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) send({ token: text });
          } catch {}
        }
      }

      send({
        done: true,
        sources: sources.map(f => ({
          id: f.id, title: f.title, folder: f.folder,
          url: `https://drive.google.com/file/d/${f.id}/view`
        }))
      });
      return res.end();

    } catch (e) {
      if (e.name === 'TimeoutError' || isOverload(0, e.message)) {
        if (i < MODELS.length-1) continue;
      }
      break;
    }
  }

  send({ error: '검색 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.', retryable: true });
  res.end();
}

// ── /api/drive-files ──
app.get('/api/drive-files', (req, res) => {
  res.json(FILE_CATALOG.map(f => ({
    id: f.id, title: f.title, folder: f.folder, desc: f.desc,
    url: `https://drive.google.com/file/d/${f.id}/view`
  })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 포트 ${PORT}`));
