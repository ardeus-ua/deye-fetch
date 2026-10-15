# deye-fetch

Раз на 5 хв (о :00, :05, :10 … UTC) бере дані інверторів з DeyeCloud developer API і надсилає їх на сайти.

Навіщо окремо: CloudFront DeyeCloud блокує IP Cloudflare (HTTP 403), тому сайт на Cloudflare Pages
не може ходити до Deye сам. З GitHub Actions Deye відповідає.

## Як працює

- `fetch.mjs` — логін (`/v1.0/account/token`), дані (`/v1.0/device/latest`), POST на `INGEST_URL`.
  Токен тримається в пам'яті; після помилки новий — не частіше ніж раз на годину.
- `.github/workflows/deye.yml` — один запуск працює ~5 г 50 хв і робить запит на кожній 5-й хвилині,
  потім запускає наступний. Щогодинний cron підхоплює, якщо ланцюжок обірвався.

## Secrets (Settings → Secrets and variables → Actions)

| Secret | |
|---|---|
| `DEYE_APP_ID`, `DEYE_APP_SECRET`, `DEYE_EMAIL`, `DEYE_PASSWORD` | акаунт DeyeCloud за замовчуванням |
| `TARGETS` | JSON-масив сайтів, див. нижче |

```json
[
  { "name": "site1", "url": "https://.../api/battery_ingest", "token": "...", "devices": ["sn1", "sn2"] },
  { "name": "site2", "url": "https://.../api/battery_ingest", "token": "...", "devices": ["sn3"],
    "deye": { "appId": "...", "appSecret": "...", "email": "...", "password": "..." } }
]
```

`deye` — необов'язковий окремий акаунт для сайту. Сайти з одним акаунтом обслуговуються одним логіном
і одним запитом даних. Без `TARGETS` — старий формат на один сайт: `DEYE_DEVICES`, `INGEST_URL`, `INGEST_TOKEN`.

Локально: `DEYE_...=... node fetch.mjs --dry` — один цикл без відправки.
