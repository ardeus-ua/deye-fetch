# deye-fetch

Раз на 5 хв (о :00, :05, :10 … UTC) бере дані інверторів з DeyeCloud developer API і надсилає їх на сайт.

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
| `DEYE_APP_ID`, `DEYE_APP_SECRET` | developer.deyecloud.com |
| `DEYE_EMAIL`, `DEYE_PASSWORD` | акаунт DeyeCloud |
| `DEYE_DEVICES` | серійні номери інверторів через кому |
| `INGEST_URL` | адреса прийому на сайті |
| `INGEST_TOKEN` | той самий токен, що на сайті |

Локально: `DEYE_...=... node fetch.mjs --dry` — один цикл без відправки.
