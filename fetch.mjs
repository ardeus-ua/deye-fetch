// Раз на 5 хв (о :00, :05, :10 ... UTC) бере дані інверторів з DeyeCloud і надсилає їх на сайт.
//
// Навіщо: CloudFront DeyeCloud блокує IP Cloudflare (403), тому сайт сам до Deye не ходить.
// GitHub Actions має звичайні IP — звідси Deye відповідає.
//
// Використання:
//   node fetch.mjs                  # один цикл
//   node fetch.mjs --minutes 350    # цикли о кожній 5-й хвилині, поки не мине 350 хв
//   node fetch.mjs --dry            # тільки показати відповідь, нічого не надсилати
//
// Змінні середовища (GitHub Secrets):
//   DEYE_APP_ID, DEYE_APP_SECRET, DEYE_EMAIL, DEYE_PASSWORD — доступ до DeyeCloud developer API
//   DEYE_DEVICES  — серійні номери інверторів через кому
//   INGEST_URL    — куди надсилати, напр. https://example.com/api/battery_ingest
//   INGEST_TOKEN  — Bearer-токен для INGEST_URL

import { createHash } from 'node:crypto';

const BASE_URL = process.env.DEYE_BASE_URL || 'https://eu1-developer.deyecloud.com';
const PERIOD_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20000;
const TOKEN_RETRY_MS = 60 * 60 * 1000; // новий токен після помилки — не частіше ніж раз на годину

const args = process.argv.slice(2);
const minutes = Number(args[args.indexOf('--minutes') + 1]) || 0;
const dry = args.includes('--dry');

const env = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Deye інколи віддає HTML (сторінка помилки / WAF) — показуємо крок, HTTP-код і заголовок сторінки
async function postJson(url, body, headers, step) {
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    try {
        return JSON.parse(text);
    } catch {
        const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
        throw new Error(`${step}: HTTP ${r.status}, not JSON${title ? ` ("${title}")` : ''}`);
    }
}

let token = null;
let tokenAttemptAt = 0;

async function newToken() {
    tokenAttemptAt = Date.now();
    const password = createHash('sha256').update(env('DEYE_PASSWORD')).digest('hex');
    const res = await postJson(`${BASE_URL}/v1.0/account/token?appId=${encodeURIComponent(env('DEYE_APP_ID'))}`,
        { appSecret: env('DEYE_APP_SECRET'), email: env('DEYE_EMAIL'), password }, {}, 'token');
    const t = res.accessToken || res?.data?.accessToken;
    if (!t) throw new Error(`token: ${res.msg || 'no accessToken'}`);
    token = t;
    log('new Deye token');
}

async function deviceLatest() {
    const devices = env('DEYE_DEVICES').split(',').map(s => s.trim()).filter(Boolean);
    const res = await postJson(`${BASE_URL}/v1.0/device/latest`, { deviceList: devices },
        { Authorization: `Bearer ${token}` }, 'device/latest');
    // API інколи повертає success=false з валідними даними — дивимось на deviceDataList
    if (!res.deviceDataList && !res.success) throw new Error(`device/latest: ${res.msg || 'API error'}`);
    return res.deviceDataList || [];
}

async function fetchDeye() {
    if (!token) await newToken();
    try {
        return await deviceLatest();
    } catch (e) {
        if (Date.now() - tokenAttemptAt < TOKEN_RETRY_MS) throw e;
        log(`retry with new token: ${e.message}`);
        await newToken();
        return deviceLatest();
    }
}

async function ingest(payload) {
    if (dry) {
        console.log(JSON.stringify(payload, null, 2).slice(0, 2000));
        return;
    }
    const r = await fetch(env('INGEST_URL'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('INGEST_TOKEN')}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`ingest HTTP ${r.status}: ${text.slice(0, 200)}`);
    // Відповідь сайту не логуємо цілком: у публічному репо логи Actions бачать усі
    let summary = '';
    try {
        const j = JSON.parse(text);
        summary = j.error ? `error: ${j.error}` : `levels: ${(j.batteries || []).map(b => b.level).join(' ')}`;
    } catch { }
    log(`ingest ok ${summary}`);
}

async function cycle() {
    const fetchedAt = new Date().toISOString();
    let payload;
    try {
        const deviceDataList = await fetchDeye();
        payload = { fetchedAt, deviceDataList };
        log(`Deye ok: ${deviceDataList.length} devices`);
    } catch (e) {
        payload = { fetchedAt, error: e.message };
        log(`Deye failed: ${e.message}`);
    }
    try {
        await ingest(payload);
    } catch (e) {
        log(`ingest failed: ${e.message}`);
    }
}

if (!minutes) {
    await cycle();
} else {
    // Цикли о кожній 5-й хвилині UTC до дедлайну; наступний запуск workflow продовжить сітку
    const deadline = Date.now() + minutes * 60 * 1000;
    for (;;) {
        const next = Math.ceil(Date.now() / PERIOD_MS) * PERIOD_MS;
        if (next >= deadline) break;
        await sleep(next - Date.now());
        await cycle();
    }
    log('loop finished');
}
