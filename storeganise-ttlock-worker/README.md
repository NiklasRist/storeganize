# TTLock ↔ Storeganise Worker

## Setup-Reihenfolge!

### 1. D1-Datenbank erstellen

```bash
npx wrangler d1 create ttlock-logs
```

Die ausgegebene `database_id` in `wrangler.jsonc` eintragen.

### 2. Schema migrieren

```bash
# Lokal (für dev)
npx wrangler d1 execute ttlock-logs --local --file=schema.sql

# Produktion
npx wrangler d1 execute ttlock-logs --file=schema.sql
```

### 3. Secrets eintragen

```bash
npx wrangler secret put TTLOCK_CLIENT_ID
npx wrangler secret put TTLOCK_CLIENT_SECRET
npx wrangler secret put TTLOCK_ACCESS_TOKEN
npx wrangler secret put STOREGANISE_API_KEY
npx wrangler secret put STOREGANISE_WEBHOOK_SECRET
npx wrangler secret put ADMIN_SECRET
```

**Wo kommen die Werte her?**

| Secret | Quelle |
|--------|--------|
| `TTLOCK_CLIENT_ID` | TTLock Developer Portal |
| `TTLOCK_CLIENT_SECRET` | TTLock Developer Portal |
| `TTLOCK_ACCESS_TOKEN` | TTLock OAuth – muss periodisch erneuert werden (30-Tage-Token) |
| `STOREGANISE_API_KEY` | Storeganise → Einstellungen → Developer → API Keys |
| `STOREGANISE_WEBHOOK_SECRET` | Storeganise → Einstellungen → Developer → Webhooks |
| `ADMIN_SECRET` | Selbst wählen, sicher aufbewahren |

### 4. Storeganise Custom Fields anlegen

Im Storeganise Admin unter Units folgende Custom Fields erstellen:

- `ttlockLockId` – Text, die TTLock Lock-ID des Schlosses pro Unit
- `ttlockKeyboardPwdId` – Text, wird automatisch vom Worker beschrieben

Dann `ttlockLockId` für jede Unit manuell eintragen.

### 5. Storeganise Webhooks konfigurieren

In Storeganise → Developer → Webhooks folgende Events abonnieren:

- `job.unit_moveIn.completed`
- `job.unit_moveOut.completed`
- `unitRental.markOverdue`
- `unitRental.unmarkOverdue`

Webhook-URL: `https://<dein-worker>.workers.dev/webhook/storeganise`

### 6. Lokal testen

```bash
npx wrangler dev
```

### 7. Deployen

```bash
npx wrangler deploy
```

### 8. TypeScript-Typen neu generieren (nach Binding-Änderungen)

```bash
npx wrangler types
```

## TTLock Access Token erneuern

TTLock Access Tokens laufen nach ~30 Tagen ab. Aktuell muss das manuell passieren:

```bash
# Neuen Token per TTLock OAuth holen, dann:
npx wrangler secret put TTLOCK_ACCESS_TOKEN
```

Token-Refresh könnte später automatisiert werden (z.B. per Cron + Refresh Token).

## Storeganise API-Endpunkte (zu verifizieren)

Die Worker nutzt diese Storeganise-Endpunkte – genaue Pfade je nach API-Version prüfen:

- `GET /api/v1/admin/jobs/:jobId`
- `GET /api/v1/admin/units/:unitId`
- `GET /api/v1/admin/unitRentals/:unitRentalId`
- `PATCH /api/v1/admin/units/:unitId` (für Custom Fields)
