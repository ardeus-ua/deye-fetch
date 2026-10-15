// Раз на 5 хв (о :00, :05, :10 ... UTC) бере дані інверторів з DeyeCloud і надсилає їх на сайти.
//
// Навіщо: CloudFront DeyeCloud блокує IP Cloudflare (403), тому сайти на Cloudflare Pages до Deye
// не ходять. GitHub Actions має звичайні IP — звідси Deye відповідає.
//
// Один цикл: один логін на акаунт Deye, ОДИН запит device/latest на всі інвертори акаунта (пачками
// по 10), далі кожен сайт отримує тільки свої інвертори.
//
// Використання:
//   node fetch.mjs                  # один цикл
//   node fetch.mjs --minutes 350    # цикли о кожній 5-й хвилині, поки не мине 350 хв
//   node fetch.mjs --dry            # тільки показати, що було б надіслано
//
// Змінні середовища (GitHub Secrets):
//   DEYE_APP_ID, DEYE_APP_SECRET, DEYE_EMAIL, DEYE_PASSWORD — акаунт DeyeCloud за замовчуванням
//   TARGETS — JSON-масив сайтів:
//     [{ "name": "drag2a", "url": "https://.../api/battery_ingest", "token": "...", "devices": ["sn", ...] },
//      { "name": "p8", ..., "deye": { "appId", "appSecret", "email", "password" } }]   <- свій акаунт (необов'язково)
//   Без TARGETS — один сайт зі старих змінних DEYE_DEVICES, INGEST_URL, INGEST_TOKEN.

import { createHash } from 'node:crypto';

const BASE_URL = process.env.DEYE_BASE_URL || 'https://eu1-developer.deyecloud.com';
const PERIOD_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20000;
const TOKEN_RETRY_MS = 60 * 60 * 1000; // новий токен після помилки — не частіше ніж раз на годину
const BATCH = 10;                      // скільки інверторів в одному запиті device/latest

const args = process.argv.slice(2);
const minutes = Number(args[args.indexOf('--minutes') + 1]) || 0;
const dry = args.includes('--dry');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadTargets() {
    const e = process.env;
    const list = e.TARGETS
        ? JSON.parse(e.TARGETS)
        : [{ name: 'site', url: e.INGEST_URL, token: e.INGEST_TOKEN, devices: String(e.DEYE_DEVICES || '').split(',') }];
    const defaultAccount = { appId: e.DEYE_APP_ID, appSecret: e.DEYE_APP_SECRET, email: e.DEYE_EMAIL, password: e.DEYE_PASSWORD };
    return list.map((t, i) => {
        const name = t.name || `target${i + 1}`;
        const devices = (t.devices || []).map(s => String(s).trim()).filter(Boolean);
        const account = t.deye || defaultAccount;
        for (const [k, v] of Object.entries({ url: t.url, token: t.token, appId: account.appId, appSecret: account.appSecret, email: account.email, password: account.password })) {
            if (!v) throw new Error(`${name}: ${k} is not set`);
        }
        if (!devices.length) throw new Error(`${name}: devices is empty`);
        return { name, url: t.url, token: t.token, devices, account };
    });
}

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

// Акаунт Deye: токен у пам'яті на весь запуск
class Account {
    constructor(cfg) {
        this.cfg = cfg;
        this.token = null;
        this.tokenAttemptAt = 0;
    }

    async newToken() {
        this.tokenAttemptAt = Date.now();
        const { appId, appSecret, email, password } = this.cfg;
        const url = `${BASE_URL}/v1.0/account/token?appId=${encodeURIComponent(appId)}`;
        const hash = createHash('sha256').update(password).digest('hex');
        // Деякі акаунти логіняться не через email, а через username — пробуємо обидва
        let res = await postJson(url, { appSecret, email, password: hash }, {}, 'token');
        let t = res.accessToken || res?.data?.accessToken;
        if (!t) {
            res = await postJson(url, { appSecret, username: email, password: hash }, {}, 'token');
            t = res.accessToken || res?.data?.accessToken;
        }
        if (!t) throw new Error(`token: ${res.msg || 'no accessToken'}`);
        this.token = t;
        log(`new Deye token (${email.replace(/^(.{3}).*(@.*)$/, '$1…$2')})`);
    }

    async deviceLatest(devices) {
        const out = [];
        for (let i = 0; i < devices.length; i += BATCH) {
            const res = await postJson(`${BASE_URL}/v1.0/device/latest`, { deviceList: devices.slice(i, i + BATCH) },
                { Authorization: `Bearer ${this.token}` }, 'device/latest');
            // API інколи повертає success=false з валідними даними — дивимось на deviceDataList
            if (!res.deviceDataList && !res.success) throw new Error(`device/latest: ${res.msg || 'API error'}`);
            out.push(...(res.deviceDataList || []));
        }
        return out;
    }

    async fetch(devices) {
        if (!this.token) await this.newToken();
        try {
            return await this.deviceLatest(devices);
        } catch (e) {
            if (Date.now() - this.tokenAttemptAt < TOKEN_RETRY_MS) throw e;
            log(`retry with new token: ${e.message}`);
            await this.newToken();
            return this.deviceLatest(devices);
        }
    }
}

async function ingest(target, payload) {
    if (dry) {
        const n = payload.deviceDataList ? `${payload.deviceDataList.length} devices` : `error: ${payload.error}`;
        log(`[dry] ${target.name}: ${n}`);
        return;
    }
    const r = await fetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    // Відповідь сайту не логуємо цілком: у публічному репо логи Actions бачать усі
    let summary = '';
    try {
        const j = JSON.parse(text);
        summary = j.error ? `error: ${j.error}` : `levels: ${(j.batteries || []).map(b => b.level).join(' ')}`;
    } catch { }
    log(`${target.name}: ingest ok ${summary}`);
}

const targets = loadTargets();

// Групуємо сайти за акаунтом Deye: один логін і один набір запитів на акаунт
const groups = new Map();
for (const t of targets) {
    const key = JSON.stringify([t.account.appId, t.account.email]);
    if (!groups.has(key)) groups.set(key, { account: new Account(t.account), targets: [] });
    groups.get(key).targets.push(t);
}

async function cycle() {
    const fetchedAt = new Date().toISOString();
    await Promise.all([...groups.values()].map(async ({ account, targets }) => {
        const devices = [...new Set(targets.flatMap(t => t.devices))];
        let list = null, error = null;
        try {
            list = await account.fetch(devices);
            log(`Deye ok: ${list.length}/${devices.length} devices`);
        } catch (e) {
            error = e.message;
            log(`Deye failed: ${error}`);
        }
        await Promise.all(targets.map(async (t) => {
            const own = new Set(t.devices);
            const payload = list
                ? { fetchedAt, deviceDataList: list.filter(d => own.has(String(d.deviceSn))) }
                : { fetchedAt, error };
            try {
                await ingest(t, payload);
            } catch (e) {
                log(`${t.name}: ingest failed: ${e.message}`);
            }
        }));
    }));
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
