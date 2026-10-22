# Loan Disbursement Cleaner & Daily Report — Online System

Secure online system with **Admin Panel** and **Client Panel**.
Preserves the original Excel cleaning and Daily Report logic.

## Features delivered

### Admin
- Dashboard: totals, uploads, clients, online users, active/expired codes
- 4-character access codes (auto or manual)
- Duration: 1–30 days or custom hours; **starts on first client activation**
- Extend / suspend / reactivate / revoke codes (server-enforced)
- Client register + upload history + amounts
- Online detection via session heartbeats (default 90s)
- Upload list with download/delete; 7-day retention cleanup
- Finance summaries by client, branch, day
- Duplicate upload detection via content hash (excluded from combined totals)
- Audit log of important actions

### Client
- Login with 4-character code
- Dashboard: expiry, remaining time, own totals
- Upload disbursement Excel + optional name map
- Same cleaning rules (skip headers/subtotals, rank officers, per-branch averages, N/A officers)
- Download Daily Report + cleaned data
- Upload history for that client only

## Quick start (local)

```bash
cd loan-report-system
cp .env.example .env
# edit .env — set ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET

npm install
npm run init-admin
npm start
```

Open:
- Admin:  http://localhost:3000/admin/
- Client: http://localhost:3000/client/

## First use

1. Log into Admin with the email/password from `init-admin`
2. **Access codes** → enter client name → choose duration → **Generate**
3. Give the 4-character code to the client
4. Client opens `/client/`, enters code, uploads Excel

## Environment variables

| Variable | Meaning |
|----------|---------|
| `PORT` | Default 3000 |
| `SESSION_SECRET` | Long random string (cookie signing) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Used by `init-admin` only |
| `FILE_RETENTION_DAYS` | Default 7 |
| `MAX_UPLOAD_MB` | Default 25 |
| `ONLINE_THRESHOLD_SECONDS` | Default 90 |

## Deploy (example: Railway / Render / VPS)

1. Push this folder to a Git repo
2. Create a Node web service
3. Set env vars (`SESSION_SECRET`, etc.)
4. Build: `npm install`
5. Start: `npm start` (or `node server/index.js`)
6. Run `npm run init-admin` once (or use a one-off job) to create the admin user
7. Put HTTPS in front (platform default or Nginx)

Data is stored under `data/` (SQLite `app.db`, `uploads/`, `reports/`).
**Back up the `data` directory regularly.**

## Security notes

- Code expiry and revocation are checked on the **server** every request
- HttpOnly signed session cookies
- Rate limits on login endpoints
- Clients cannot access other clients' files
- Admin file download requires admin session
- 4-character codes are short: keep attempt limits and revoke compromised codes quickly

## Architecture

```
Browser Admin UI  ──┐
                    ├── Express API ── SQLite ── data/uploads
Browser Client UI ──┘
Excel cleaning runs in the client browser (fast for 5k+ rows),
then totals + original file are posted to the server for audit and finance.
```

## Acceptance checklist

- [x] Admin login
- [x] Create 4-char code with duration from first activation
- [x] Server-side expiry / revoke
- [x] Client login + existing cleaner/report
- [x] Upload totals on admin + client dashboards
- [x] Online clients via heartbeat
- [x] File list + authorized download + delete
- [x] Duplicate hash flag for combined totals
- [x] Deployable Node app with env config
