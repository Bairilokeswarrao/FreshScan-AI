# FreshScan AI – Full Project (Frontend + Backend)

Your original `FreshScanAI` page, now served by a real Node.js backend.
**No npm dependencies** – only Node.js 18+ is required.

## Quick start

```bash
cd freshscan-ai
cp .env.example .env      # optional
npm start                 # or: node server.js
```

Open **http://localhost:3000**, click **Create an account**, then start scanning.
(Use `localhost` or HTTPS – browsers only allow the camera on secure origins.)

Run the tests: `npm test`

## What the backend does

| Feature | How |
|---|---|
| Accounts | Register / login / logout, scrypt password hashing, signed HttpOnly session cookie ("Remember me" = 30 days, otherwise browser session) |
| Forgot password | Generates a one-hour reset token (printed in the server console; returned to the page only when `EXPOSE_RESET_TOKEN=true`, for development). Resetting a password logs out all old sessions |
| Food validation | The browser runs MobileNet; the server receives the top predictions and decides food / non-food (non-food returns HTTP 422) |
| Freshness analysis | Server computes a score from image colour statistics (browning, dark spots, dullness), shelf life by food category, risk and summary. Same image → same score (no more `Math.random`) |
| Scan history | Saved per user (images stored in `data/uploads`, latest 100 kept), list / delete one / clear all, stats |
| Feedback | Saved to the database; admins can read it |
| Security | Rate limiting on auth, per-user data isolation, JSON-only POSTs, body size limits, path-traversal protection, security headers, XSS-safe history rendering |

## Project layout

```
server.js          HTTP server + router
src/config.js      env + settings        src/auth.js      passwords & sessions
src/routes.js      all API endpoints     src/analysis.js  food check + freshness scoring
src/store.js       JSON-file database    src/http.js      helpers, rate limit, static files
public/index.html  your frontend (now calling the API)
data/              db.json, uploads/, secret.key  (created at runtime)
test/api.test.js   end-to-end API tests
```

## API reference

All bodies are JSON. Auth is via the `fs_token` cookie (or `Authorization: Bearer <token>`).

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/auth/register` | `{name, email, password(min 8), remember}` |
| POST | `/api/auth/login` | `{email, password, remember}` |
| POST | `/api/auth/logout` | Clears the session |
| GET | `/api/auth/me` | Current user |
| POST | `/api/auth/forgot` | `{email}` |
| POST | `/api/auth/reset` | `{token, password}` |
| POST | `/api/scans` | `{image(dataURL), predictions[], features?, label?, latencyMs?}` → 201 scan, or 422 `not_food` |
| GET | `/api/scans?limit=50` | Your scan history |
| GET | `/api/scans/stats` | `{total, averageScore, safe, caution}` |
| GET | `/api/scans/:id` | One scan |
| GET | `/api/scans/:id/image` | The stored image (owner only) |
| DELETE | `/api/scans/:id` | Delete one scan |
| DELETE | `/api/scans` | Clear all your scans |
| POST | `/api/feedback` | `{name, category, rating 1-5, notes}` |
| GET | `/api/feedback` | Admin only |

## Configuration (`.env`)

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | Listen address (default `3000`, `0.0.0.0`) |
| `NODE_ENV=production` | Adds the `Secure` flag to cookies – use behind HTTPS |
| `SESSION_SECRET` | Token-signing secret. If empty, one is generated in `data/secret.key` |
| `ADMIN_EMAIL` | The account registered with this email gets the admin role |
| `EXPOSE_RESET_TOKEN` | `true` = dev-only shortcut for the password reset flow |
| `DATA_DIR` | Where to keep db + uploads |

## Notes & next steps

* **Email**: no mail service is wired in. To send real reset emails, call your provider in the `/api/auth/forgot` handler in `src/routes.js` and set `EXPOSE_RESET_TOKEN=false`.
* **Database**: `src/store.js` is a simple JSON file database, ideal for one server instance. For heavier use, swap it for PostgreSQL/MongoDB/SQLite.
* **AI model**: classification still runs in the browser with MobileNet (loaded from a CDN, so the first scan needs internet). Freshness is estimated from colour statistics – it is a heuristic, **not** a certified food-safety test.
