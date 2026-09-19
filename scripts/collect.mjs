// scripts/collect.mjs
// GitHub Actions에서 매일(또는 수동 실행) 돌아가는 자동 수집 스크립트.
// records.json에 signal_id + record_date 기준으로 원자적 갱신(merge)한다.
// 어떤 신호가 실패해도 다른 신호나 기존 값에는 영향을 주지 않는다.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDS_PATH = path.join(__dirname, '..', 'records.json');

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple&vs_currencies=usd&include_last_updated_at=true';
const FNG_URL = 'https://api.alternative.me/fng/';

const COIN_META = {
  bitcoin: { signal_id: 'bitcoin-usd', source_name: 'CoinGecko', label: '비트코인' },
  ethereum: { signal_id: 'ethereum-usd', source_name: 'CoinGecko', label: '이더리움' },
  ripple: { signal_id: 'ripple-usd', source_name: 'CoinGecko', label: '리플' },
};

/* ---------------------------- 공통 유틸 --------------------------------- */

export function kstDate(isoString) {
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

/* ------------------------- 신호별 정규화 빌더 ------------------------- */

export function buildCoinReading(coinId, priceEntry, fetchedAt) {
  const meta = COIN_META[coinId];
  if (!meta) throw new Error(`unknown coin id: ${coinId}`);
  if (!priceEntry || typeof priceEntry.usd !== 'number') {
    throw new Error(`missing/invalid usd price for ${coinId}`);
  }
  const sourceTime = priceEntry.last_updated_at
    ? new Date(priceEntry.last_updated_at * 1000).toISOString()
    : null;
  return {
    signal_id: meta.signal_id,
    normalized_value: priceEntry.usd,
    unit: 'USD',
    source_name: meta.source_name,
    source_url: `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
    source_observed_at: sourceTime,
    fetched_at: fetchedAt,
    record_timezone: 'Asia/Seoul',
    record_date: kstDate(fetchedAt),
  };
}

export function buildFngReading(fngJson, fetchedAt) {
  const row = fngJson && Array.isArray(fngJson.data) ? fngJson.data[0] : null;
  const numericValue = row ? Number(row.value) : NaN;
  if (!row || Number.isNaN(numericValue)) throw new Error('invalid fear&greed payload');
  return {
    signal_id: 'crypto-fear-greed-index',
    normalized_value: numericValue,
    unit: '점',
    value_classification: row.value_classification || null,
    source_name: 'Alternative.me Fear & Greed Index',
    source_url: FNG_URL,
    source_observed_at: new Date(Number(row.timestamp) * 1000).toISOString(),
    fetched_at: fetchedAt,
    record_timezone: 'Asia/Seoul',
    record_date: kstDate(fetchedAt),
  };
}

/* ------------------------------- 병합 로직 ------------------------------- */

// 기존 records 배열에 새 reading을 signal_id+record_date 기준으로 원자적 갱신.
// 실패한 신호는 애초에 여기 들어오지 않으므로 기존 값이 그대로 보존된다.
export function mergeReading(records, reading) {
  const next = [...records];
  const idx = next.findIndex(
    (r) => r.signal_id === reading.signal_id && r.record_date === reading.record_date
  );
  if (idx >= 0) next[idx] = reading;
  else next.push(reading);
  next.sort((a, b) => a.record_date.localeCompare(b.record_date) || a.signal_id.localeCompare(b.signal_id));
  return next;
}

/* --------------------------------- 실행 --------------------------------- */

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

export async function collectOnce({ now = new Date().toISOString() } = {}) {
  const raw = await readFile(RECORDS_PATH, 'utf8').catch(() => '[]');
  let records = JSON.parse(raw);

  const results = { ok: [], failed: [] };

  // 코인 3종 (한 번의 호출로 같이 가져옴)
  try {
    const priceJson = await fetchJson(COINGECKO_URL);
    for (const coinId of Object.keys(COIN_META)) {
      try {
        const reading = buildCoinReading(coinId, priceJson[coinId], now);
        records = mergeReading(records, reading);
        results.ok.push(reading.signal_id);
      } catch (err) {
        results.failed.push({ signal_id: COIN_META[coinId].signal_id, reason: err.message });
      }
    }
  } catch (err) {
    for (const coinId of Object.keys(COIN_META)) {
      results.failed.push({ signal_id: COIN_META[coinId].signal_id, reason: `coingecko fetch failed: ${err.message}` });
    }
  }

  // 공포탐욕지수
  try {
    const fngJson = await fetchJson(FNG_URL);
    const reading = buildFngReading(fngJson, now);
    records = mergeReading(records, reading);
    results.ok.push(reading.signal_id);
  } catch (err) {
    results.failed.push({ signal_id: 'crypto-fear-greed-index', reason: err.message });
  }

  await writeFile(RECORDS_PATH, JSON.stringify(records, null, 2) + '\n', 'utf8');
  return results;
}

// 직접 실행됐을 때만 동작 (테스트 스크립트에서 import할 땐 실행 안 됨)
if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await collectOnce();
  console.log('성공:', results.ok.join(', ') || '(없음)');
  if (results.failed.length) {
    console.log('실패:', JSON.stringify(results.failed, null, 2));
  }
  if (results.ok.length === 0) {
    console.error('모든 신호 수집 실패');
    process.exit(1);
  }
}
