'use strict';

/* =========================================================================
 * 크립토 시황판 — BTC·ETH·XRP 시세, 공포탐욕지수 실시간 조회/일별 기록/장애 재현
 * ========================================================================= */

const FNG_SOURCE_URL = 'https://api.alternative.me/fng/';
const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple&vs_currencies=usd&include_last_updated_at=true';

// 실시간으로 추적하는 신호 4종. records.json(자동 커밋)도 같은 signal_id를 씁니다.
const LIVE_SIGNALS = [
  { id: 'bitcoin-usd', label: '비트코인 (BTC)', short: 'BTC', unit: 'USD', kind: 'coin', coinId: 'bitcoin' },
  { id: 'ethereum-usd', label: '이더리움 (ETH)', short: 'ETH', unit: 'USD', kind: 'coin', coinId: 'ethereum' },
  { id: 'ripple-usd', label: '리플 (XRP)', short: 'XRP', unit: 'USD', kind: 'coin', coinId: 'ripple' },
  { id: 'crypto-fear-greed-index', label: '공포탐욕지수', unit: '점', kind: 'fng' },
];

const ERROR_CODES = ['timeout', 'auth', 'rate_limit', 'offline', 'schema_error'];

const ERROR_LABELS = {
  none: '정상',
  timeout: '⏱ 응답 지연 (timeout)',
  auth: '🔒 인증 거절 401/403 (auth)',
  rate_limit: '🚦 호출 제한 429 (rate_limit)',
  offline: '📡 오프라인 (offline)',
  schema_error: '⚠ 응답 형식 변경 (schema_error)',
};

const CLASS_LABELS_KO = {
  'Extreme Fear': '극단적 공포',
  Fear: '공포',
  Neutral: '중립',
  Greed: '탐욕',
  'Extreme Greed': '극단적 탐욕',
};

const FIXTURE_FILES = {
  'T04-NORMAL-D1-A': 'fixtures/normal-d1-a.json',
  'T04-NORMAL-D1-B': 'fixtures/normal-d1-b.json',
  'T04-NORMAL-D2': 'fixtures/normal-d2.json',
  'T04-TIMEOUT': 'fixtures/timeout.json',
  'T04-AUTH-401': 'fixtures/auth-401.json',
  'T04-RATE-429': 'fixtures/rate-429.json',
  'T04-OFFLINE': 'fixtures/offline.json',
  'T04-SCHEMA-BREAK': 'fixtures/schema-break.json',
  'T04-RECOVER-D2': 'fixtures/recover-d2.json',
};

/* ---------------------------- 공통 유틸 --------------------------------- */

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetched_at(ISO)을 Asia/Seoul 날짜(YYYY-MM-DD)로 변환
function kstDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) throw new TypeError('invalid date-time');
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

// 화면 표시용 KST 시각 문자열
function formatKst(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second} KST`;
}

/* ------------------------- 엔진: 정상/실패 상태 전이 ------------------------- */

function resetEvaluationState() {
  return {
    daily_readings: [],
    current_reading: null,
    status: null,
    last_delta: null,
    last_comparison: { state: 'insufficient', direction: null, magnitude: null, unit: null },
    last_run: null,
  };
}

function recordIdFor(reading) {
  return `${reading.signal_id}-${reading.record_date}`;
}

function comparisonFor(rows, current) {
  const previous = rows
    .filter((r) => r.signal_id === current.signal_id && r.record_date < current.record_date)
    .sort((a, b) => b.record_date.localeCompare(a.record_date))[0];
  if (!previous) return { state: 'insufficient', direction: null, magnitude: null, unit: null };
  if (previous.unit !== current.unit) return { state: 'unit_mismatch', direction: null, magnitude: null, unit: null };
  const signed = current.normalized_value - previous.normalized_value;
  return {
    state: 'comparable',
    direction: signed > 0 ? 'increase' : signed < 0 ? 'decrease' : 'unchanged',
    magnitude: Math.abs(signed),
    unit: current.unit,
  };
}

function applySuccessfulReading(inputState, reading, runMeta = {}) {
  const state = clone(inputState);
  const idx = state.daily_readings.findIndex(
    (r) => r.signal_id === reading.signal_id && r.record_date === reading.record_date
  );
  const existing = idx >= 0 ? state.daily_readings[idx] : null;
  const row = {
    record_id: existing ? existing.record_id : recordIdFor(reading),
    signal_id: reading.signal_id,
    record_date: reading.record_date,
    normalized_value: reading.normalized_value,
    unit: reading.unit,
    first_fetched_at: existing ? existing.first_fetched_at : reading.fetched_at,
    last_fetched_at: reading.fetched_at,
    reading: clone(reading),
  };
  if (idx >= 0) state.daily_readings[idx] = row;
  else state.daily_readings.push(row);
  state.daily_readings.sort((a, b) => a.record_date.localeCompare(b.record_date));

  state.current_reading = clone(reading);
  state.status = { freshness: 'fresh', error_code: 'none' };
  state.last_comparison = comparisonFor(state.daily_readings, row);
  state.last_delta = state.last_comparison.magnitude;
  state.last_run = {
    fixture_id: runMeta.fixture_id || null,
    outcome: 'success',
    error_code: 'none',
    retry_after_seconds: null,
  };
  return state;
}

function applyError(inputState, errorCode, runMeta = {}) {
  const state = clone(inputState);
  state.status = { freshness: 'stale', error_code: errorCode };
  state.last_run = {
    fixture_id: runMeta.fixture_id || null,
    outcome: 'error',
    error_code: errorCode,
    retry_after_seconds: runMeta.retry_after_seconds ?? null,
  };
  return state;
}

// transport 결과(모드/상태코드)를 error_code로 분류. fixture 재생과 실시간 조회가
// 둘 다 이 함수를 거쳐 applyError/applySuccessfulReading으로 들어간다.
function classifyTransport(transport) {
  if (transport.mode === 'timeout') return 'timeout';
  if (transport.mode === 'offline') return 'offline';
  if (transport.status === 401 || transport.status === 403) return 'auth';
  if (transport.status === 429) return 'rate_limit';
  if (transport.status >= 200 && transport.status < 300) return null; // 성공 — payload 검사는 호출자 몫
  return 'schema_error';
}

function runFixture(inputState, fixture) {
  const meta = {
    fixture_id: fixture.fixture_id,
    retry_after_seconds: fixture.transport.headers['retry-after']
      ? Number(fixture.transport.headers['retry-after'])
      : null,
  };
  const errorCode = classifyTransport(fixture.transport);
  if (errorCode) return applyError(inputState, errorCode, meta);
  if (typeof fixture.payload.normalized_value !== 'number') {
    return applyError(inputState, 'schema_error', meta);
  }
  return applySuccessfulReading(inputState, fixture.payload, meta);
}

/* ============================ 카드 1: 실시간 조회 ============================ */
/* 가격(BTC/ETH/XRP)과 심리(공포탐욕지수)를 별도 그룹으로 렌더링 — 하나가 실패해도
   나머지는 독립적으로 표시됨 */

// 실시간 조회 전용 엔진 상태 — 신호별로 하나씩, resetEvaluationState()로 초기화.
// fixture 재생과 똑같이 applyError/applySuccessfulReading을 거치므로, 장애 재현
// 테스트에서 검증한 상태 전이가 실제 조회에도 그대로 적용됨을 코드로 보장한다.
const liveStates = {};
LIVE_SIGNALS.forEach((sig) => { liveStates[sig.id] = resetEvaluationState(); });
let fngClassification = null;

async function fetchLiveReadings() {
  renderPriceGroup(LIVE_SIGNALS.filter((s) => s.kind === 'coin').map((sig) => ({ sig, loading: true })));
  renderSentimentGroup({ loading: true });

  const fetchWithTimeout = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  };

  // 실제 fetch 결과를 fixture와 같은 형태(transport descriptor)로 바꿔서
  // classifyTransport에 넘긴다 — fixture 재생과 완전히 같은 분류 함수를 탄다.
  const runTransport = async (url) => {
    try {
      const res = await fetchWithTimeout(url);
      return { transport: { mode: 'http', status: res.status }, res };
    } catch (err) {
      const mode = err && err.name === 'AbortError' ? 'timeout' : 'offline';
      return { transport: { mode }, res: null };
    }
  };

  // 일시적 장애(timeout/offline/rate_limit)는 최대 1회 더 자동 재시도한다.
  const runTransportWithRetry = async (url, maxAttempts = 2) => {
    let result;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result = await runTransport(url);
      const code = classifyTransport(result.transport);
      const retryable = code === 'timeout' || code === 'offline' || code === 'rate_limit';
      if (!retryable || attempt === maxAttempts) return result;
      await sleep(700);
    }
    return result;
  };

  const fetchedAt = new Date().toISOString();
  const coinSignals = LIVE_SIGNALS.filter((s) => s.kind === 'coin');
  const runMeta = {};

  // 코인 3종 (한 번의 호출 — transport 단계 에러는 3종 모두에 동일 적용)
  let priceRawResponse = null;
  const { transport: priceTransport, res: priceRes } = await runTransportWithRetry(COINGECKO_URL);
  const priceTransportError = classifyTransport(priceTransport);
  let priceJson = null;
  if (!priceTransportError) priceJson = await priceRes.json();
  priceRawResponse = priceJson;

  coinSignals.forEach((sig) => {
    if (priceTransportError) {
      liveStates[sig.id] = applyError(liveStates[sig.id], priceTransportError, runMeta);
      return;
    }
    const entry = priceJson[sig.coinId];
    if (!entry || typeof entry.usd !== 'number') {
      liveStates[sig.id] = applyError(liveStates[sig.id], 'schema_error', runMeta);
      return;
    }
    const reading = {
      signal_id: sig.id,
      normalized_value: entry.usd,
      unit: sig.unit,
      source_name: 'CoinGecko',
      source_url: `https://api.coingecko.com/api/v3/simple/price?ids=${sig.coinId}&vs_currencies=usd`,
      source_time: entry.last_updated_at ? new Date(entry.last_updated_at * 1000).toISOString() : null,
      fetched_at: fetchedAt,
      record_timezone: 'Asia/Seoul',
      record_date: kstDate(fetchedAt),
    };
    liveStates[sig.id] = applySuccessfulReading(liveStates[sig.id], reading, runMeta);
  });
  renderPriceGroup(coinSignals.map((sig) => ({ sig, state: liveStates[sig.id] })), priceRawResponse);

  // 공포탐욕지수
  const { transport: fngTransport, res: fngRes } = await runTransportWithRetry(FNG_SOURCE_URL);
  const fngTransportError = classifyTransport(fngTransport);
  let fngRaw = null;
  if (fngTransportError) {
    liveStates['crypto-fear-greed-index'] = applyError(liveStates['crypto-fear-greed-index'], fngTransportError, runMeta);
  } else {
    const json = await fngRes.json();
    fngRaw = json;
    const row = json && Array.isArray(json.data) ? json.data[0] : null;
    const numericValue = row ? Number(row.value) : NaN;
    if (!row || Number.isNaN(numericValue)) {
      liveStates['crypto-fear-greed-index'] = applyError(liveStates['crypto-fear-greed-index'], 'schema_error', runMeta);
    } else {
      fngClassification = row.value_classification;
      const reading = {
        signal_id: 'crypto-fear-greed-index',
        normalized_value: numericValue,
        unit: '점',
        source_name: 'Alternative.me Fear & Greed Index',
        source_url: FNG_SOURCE_URL,
        source_time: new Date(Number(row.timestamp) * 1000).toISOString(),
        fetched_at: fetchedAt,
        record_timezone: 'Asia/Seoul',
        record_date: kstDate(fetchedAt),
      };
      liveStates['crypto-fear-greed-index'] = applySuccessfulReading(liveStates['crypto-fear-greed-index'], reading, runMeta);
    }
  }
  renderSentimentGroup({ state: liveStates['crypto-fear-greed-index'], raw: fngRaw });
}

function renderPriceGroup(items, rawApiResponse) {
  const liveEl = document.getElementById('price-live');
  const metaEl = document.getElementById('price-meta');
  const rawWrap = document.getElementById('price-raw-wrap');
  const rawEl = document.getElementById('price-raw');

  liveEl.innerHTML = items.map((item) => {
    if (item.loading) {
      return `<div class="price-line"><span class="coin-code">${item.sig.short}</span><span class="live-loading-text">조회 중...</span></div>`;
    }
    const { status, current_reading } = item.state;
    if (status.freshness === 'stale') {
      if (!current_reading) {
        return `<div class="price-line"><span class="coin-code">${item.sig.short}</span><span class="live-error-text">조회 실패 — ${ERROR_LABELS[status.error_code] || status.error_code}</span></div>`;
      }
      return `
        <div class="price-line">
          <span class="coin-code">${item.sig.short}</span>
          <span class="price-right">
            <span class="mono price-value">${current_reading.normalized_value.toLocaleString('en-US')}<span class="unit">${current_reading.unit}</span></span>
            <span class="price-time mono">출처시각 ${formatKst(current_reading.source_time)}</span>
            <span class="price-time" style="color:var(--red);">⚠ 오래된 값 — ${ERROR_LABELS[status.error_code] || status.error_code}</span>
          </span>
        </div>
      `;
    }
    const reading = current_reading;
    return `
      <div class="price-line">
        <span class="coin-code">${item.sig.short}</span>
        <span class="price-right">
          <span class="mono price-value">${reading.normalized_value.toLocaleString('en-US')}<span class="unit">${reading.unit}</span></span>
          <span class="price-time mono">출처시각 ${formatKst(reading.source_time)}</span>
        </span>
      </div>
    `;
  }).join('');

  // 이번 재조회가 전부 실패해도 시드/직전 조회로 값이 남아 있으면
  // 출처·조회시각·기준시간대 줄과 원자료 보기를 비우지 않는다.
  const freshItems = items.filter((item) => !item.loading && item.state.status && item.state.status.freshness === 'fresh');
  const readableItems = items.filter((item) => !item.loading && item.state.current_reading);
  const metaSource = freshItems.length ? freshItems : readableItems;
  if (metaSource.length) {
    const sample = metaSource[0].state.current_reading;
    const staleNote = freshItems.length ? '' : ' · ⚠ 지금 재조회 실패 — 마지막 정상 조회 기준';
    metaEl.textContent = `출처 ${sample.source_name} · 조회시각 ${formatKst(sample.fetched_at)} · 기준시간대 ${sample.record_timezone}${staleNote}`;
    rawWrap.hidden = false;
    rawEl.textContent = JSON.stringify(
      { normalized: metaSource.map((item) => item.state.current_reading), raw_api_response: freshItems.length ? rawApiResponse : null },
      null,
      2
    );
  } else {
    metaEl.textContent = '';
    rawWrap.hidden = true;
  }
}

function renderSentimentGroup(payload) {
  const liveEl = document.getElementById('fng-live');
  if (payload.loading) {
    liveEl.innerHTML = '<p class="live-loading-text">조회 중...</p>';
    return;
  }
  const { status, current_reading } = payload.state;
  if (status.freshness === 'stale') {
    if (!current_reading) {
      liveEl.innerHTML = `<p class="live-error-text">조회 실패 — ${ERROR_LABELS[status.error_code] || status.error_code}</p>`;
      return;
    }
    liveEl.innerHTML = `
      <div class="feature-value mono">${current_reading.normalized_value}<span class="unit">${current_reading.unit}</span></div>
      <div class="class-line" style="color:var(--red);">⚠ 오래된 값 — ${ERROR_LABELS[status.error_code] || status.error_code}</div>
      <div class="meta-line">
        출처 <a href="${current_reading.source_url}" target="_blank" rel="noopener">${current_reading.source_name}</a> ·
        출처시각 ${formatKst(current_reading.source_time)}<br/>
        조회시각 ${formatKst(current_reading.fetched_at)} · 기준시간대 ${current_reading.record_timezone}
      </div>
      <details class="raw-wrap">
        <summary>실시간 원자료(API 응답) 보기</summary>
        <pre>${JSON.stringify({ normalized: current_reading }, null, 2)}</pre>
      </details>
    `;
    return;
  }
  const reading = current_reading;
  const classKo = fngClassification ? (CLASS_LABELS_KO[fngClassification] || fngClassification) : '';
  liveEl.innerHTML = `
    <div class="feature-value mono">${reading.normalized_value}<span class="unit">${reading.unit}</span></div>
    ${classKo ? `<div class="class-line">${classKo}</div>` : ''}
    <div class="meta-line">
      출처 <a href="${reading.source_url}" target="_blank" rel="noopener">${reading.source_name}</a> ·
      출처시각 ${formatKst(reading.source_time)}<br/>
      조회시각 ${formatKst(reading.fetched_at)} · 기준시간대 ${reading.record_timezone}
    </div>
    <details class="raw-wrap">
      <summary>실시간 원자료(API 응답) 보기</summary>
      <pre>${JSON.stringify({ normalized: reading, raw_api_response: payload.raw }, null, 2)}</pre>
    </details>
  `;
}

/* ========================= 카드 2: 일별 보존 기록 ========================== */

let preservedRecords = [];

async function loadPreservedRecords() {
  try {
    const res = await fetch('./records.json', { cache: 'no-store' });
    preservedRecords = res.ok ? await res.json() : [];
  } catch {
    preservedRecords = [];
  }
  seedLiveStatesFromPreserved();
  renderPreservedRecords();
}

// 이번 세션의 실시간 조회가 실패해도 화면에서 값이 통째로 사라지지 않도록,
// GitHub Actions가 보존한 신호별 최신 기록을 liveStates 초기값으로 채워 둔다.
// 이후 fetchLiveReadings가 성공하면 최신값으로 덮어써지고, 실패하면 applyError가
// 이 시드값을 stale로 표시한 채 그대로 보존한다.
function seedLiveStatesFromPreserved() {
  LIVE_SIGNALS.forEach((sig) => {
    if (liveStates[sig.id].current_reading) return;
    const rows = preservedRecords
      .filter((r) => r.signal_id === sig.id)
      .sort((a, b) => a.record_date.localeCompare(b.record_date));
    if (!rows.length) return;
    const latest = rows[rows.length - 1];
    liveStates[sig.id].current_reading = {
      signal_id: latest.signal_id,
      normalized_value: latest.normalized_value,
      unit: latest.unit,
      source_name: latest.source_name,
      source_url: latest.source_url,
      source_time: latest.source_observed_at,
      fetched_at: latest.fetched_at,
      record_timezone: latest.record_timezone,
      record_date: latest.record_date,
    };
  });
}

function renderPreservedRecords() {
  renderPriceHistory();
  renderSentimentHistory();
}

function renderPriceHistory() {
  const container = document.getElementById('price-history');
  const coinSignals = LIVE_SIGNALS.filter((s) => s.kind === 'coin');
  const bySignal = Object.fromEntries(
    coinSignals.map((s) => [
      s.id,
      preservedRecords.filter((r) => r.signal_id === s.id).sort((a, b) => a.record_date.localeCompare(b.record_date)),
    ])
  );
  const dates = [...new Set(coinSignals.flatMap((s) => bySignal[s.id].map((r) => r.record_date)))].sort();

  if (dates.length === 0) {
    container.innerHTML = '<p class="empty">아직 보존된 실제 기록이 없습니다. GitHub Actions 자동 수집이 처음 실행되면 여기 나타납니다.</p>';
    return;
  }

  const header = `<tr><th></th>${coinSignals.map((s) => `<th>${s.short}</th>`).join('')}</tr>`;
  const bodyRows = dates.map((date) => {
    const cells = coinSignals.map((s) => {
      const rec = bySignal[s.id].find((r) => r.record_date === date);
      return `<td class="mono">${rec ? rec.normalized_value.toLocaleString('en-US') : '—'}</td>`;
    }).join('');
    return `<tr><td class="mono">${date}</td>${cells}</tr>`;
  }).join('');

  const deltaParts = coinSignals.map((s) => {
    const rows = bySignal[s.id];
    if (rows.length < 2) return `${s.short} ${rows.length}건`;
    const [prev, curr] = rows.slice(-2);
    const diff = curr.normalized_value - prev.normalized_value;
    const dir = diff > 0 ? '▲' : diff < 0 ? '▼' : '±';
    return `${s.short} ${dir}${Math.abs(diff).toLocaleString('en-US')}`;
  });

  container.innerHTML = `
    <table class="history-table">${header}${bodyRows}</table>
    <div class="records-delta">${deltaParts.join(' · ')}</div>
    <details class="raw-wrap" style="margin-top:8px;">
      <summary>일별 기록 원자료 보기 (BTC·ETH·XRP)</summary>
      <pre>${JSON.stringify(coinSignals.flatMap((s) => bySignal[s.id]), null, 2)}</pre>
    </details>
  `;
}

function renderSentimentHistory() {
  const container = document.getElementById('fng-history');
  const rows = preservedRecords
    .filter((r) => r.signal_id === 'crypto-fear-greed-index')
    .sort((a, b) => a.record_date.localeCompare(b.record_date));

  if (rows.length === 0) {
    container.innerHTML = '<p class="empty">아직 보존된 실제 기록이 없습니다.</p>';
    return;
  }

  const listHtml = rows.map((row) => `
    <li class="record-row">
      <div class="record-summary">
        <span class="record-date">${row.record_date}</span>
        <span class="record-value">${row.normalized_value} ${row.unit}</span>
        <span class="record-class">${CLASS_LABELS_KO[row.value_classification] || row.value_classification || ''}</span>
        <button class="raw-toggle" type="button">원자료 보기</button>
      </div>
      <pre class="raw-detail" hidden>${JSON.stringify(row, null, 2)}</pre>
    </li>
  `).join('');

  let deltaText;
  if (rows.length >= 2) {
    const [prev, curr] = rows.slice(-2);
    const diff = curr.normalized_value - prev.normalized_value;
    const dir = diff > 0 ? '▲ 상승' : diff < 0 ? '▼ 하락' : '변동 없음';
    deltaText = `전일(${prev.record_date} → ${curr.record_date}) 대비: ${dir} ${Math.abs(diff)} ${curr.unit}`;
  } else {
    deltaText = `실제 기록 ${rows.length}건 — 2건이 모이면 전일 대비가 표시됩니다.`;
  }

  container.innerHTML = `<ul class="records-list">${listHtml}</ul><div class="records-delta">${deltaText}</div>`;
  container.querySelectorAll('.raw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pre = btn.closest('.record-row').querySelector('.raw-detail');
      pre.hidden = !pre.hidden;
    });
  });
}

/* ========================= 카드 3: 수신 테스트(합성) ========================= */

let sandbox = resetEvaluationState();

async function runTest(fixtureId) {
  const file = FIXTURE_FILES[fixtureId];
  const res = await fetch(`./${file}`, { cache: 'no-store' });
  const fixture = await res.json();

  const btns = document.querySelectorAll('#test-panel button');
  btns.forEach((b) => (b.disabled = true));
  setTestNote(`${fixtureId} 재생 중...`);

  await sleep(Math.min(fixture.transport.delay_ms || 0, 2000));

  sandbox = runFixture(sandbox, fixture);
  renderSandbox(fixtureId);

  btns.forEach((b) => (b.disabled = false));
}

function resetSandboxState() {
  sandbox = resetEvaluationState();
  renderSandbox('RESET');
  setTestNote('합성 상태를 초기화했습니다. (실제 기록에는 영향 없음)');
}

function setTestNote(text) {
  document.getElementById('test-note').textContent = text;
}

function renderSandbox(lastFixtureId) {
  const box = document.getElementById('test-status');
  if (!sandbox.status) {
    box.innerHTML = '<p>아직 합성 조회가 실행되지 않았습니다.</p>';
    return;
  }
  const { freshness, error_code } = sandbox.status;
  const rowCount = sandbox.daily_readings.length;
  const lastRow = sandbox.daily_readings.length
    ? sandbox.daily_readings[sandbox.daily_readings.length - 1]
    : null;
  const storedValue = lastRow ? lastRow.normalized_value : null;
  const storedUnit = lastRow ? lastRow.unit : '';
  const freshClass = freshness === 'fresh' ? 'fresh' : 'stale';
  const freshLabel = freshness === 'fresh' ? `최신 (${freshness})` : `⚠ 오래된 값 · 마지막 정상값 (${freshness})`;

  box.innerHTML = `
    <div class="status-grid">
      <div class="status-row"><span class="label">마지막 재생</span><span class="mono">${lastFixtureId}</span></div>
      <div class="status-row"><span class="label">상태</span><span class="${freshClass}">${freshLabel}</span></div>
      <div class="status-row"><span class="label">실패 사유</span><span>${ERROR_LABELS[error_code] || error_code}</span></div>
      <div class="status-row"><span class="label">일별 행 개수</span><span class="mono">${rowCount}</span></div>
      <div class="status-row"><span class="label">저장된 값</span><span class="mono">${storedValue !== null ? storedValue + ' ' + storedUnit : '—'}</span></div>
      <div class="status-row"><span class="label">전일 대비</span><span>${sandbox.last_comparison.state === 'comparable' ? (sandbox.last_comparison.direction + ' ' + sandbox.last_comparison.magnitude) : sandbox.last_comparison.state}</span></div>
      ${sandbox.last_run && sandbox.last_run.retry_after_seconds ? `<div class="status-row"><span class="label">Retry-After</span><span class="mono">${sandbox.last_run.retry_after_seconds}초</span></div>` : ''}
    </div>
    ${sandbox.current_reading ? `
      <details class="raw-wrap" style="margin-top:8px;">
        <summary>현재 합성 값 상세 보기</summary>
        <div class="status-grid" style="margin-top:6px;">
          <div class="status-row"><span class="label">값</span><span class="mono">${sandbox.current_reading.normalized_value} ${sandbox.current_reading.unit}</span></div>
          <div class="status-row"><span class="label">출처</span><span>${sandbox.current_reading.source_name}</span></div>
          <div class="status-row"><span class="label">출처 시각</span><span class="mono">${formatKst(sandbox.current_reading.source_time)}</span></div>
          <div class="status-row"><span class="label">조회 시각</span><span class="mono">${formatKst(sandbox.current_reading.fetched_at)}</span></div>
        </div>
        <pre>${JSON.stringify(sandbox.current_reading, null, 2)}</pre>
      </details>
    ` : ''}
  `;
}

/* ================================ 초기화 ================================ */

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('live-refetch').addEventListener('click', fetchLiveReadings);
  await loadPreservedRecords(); // liveStates 시드가 끝난 뒤에 첫 실시간 조회를 시작한다.
  fetchLiveReadings();

  const clockEl = document.getElementById('board-clock');
  const tickClock = () => { clockEl.textContent = formatKst(new Date().toISOString()); };
  tickClock();
  setInterval(tickClock, 1000);

  document.getElementById('btn-reset').addEventListener('click', resetSandboxState);

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.getElementById('tab-panel-board').hidden = target !== 'board';
      document.getElementById('tab-panel-test').hidden = target !== 'test';
    });
  });
  Object.keys(FIXTURE_FILES).forEach((id) => {
    const btn = document.querySelector(`[data-fixture="${id}"]`);
    if (btn) btn.addEventListener('click', () => runTest(id));
  });

  renderSandbox('INIT');
});
