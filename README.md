# 🧪 ReqLab — a lightweight API client

> 👋 **New here?** Read the short, plain-language **[user guide (GUIDE.md)](GUIDE.md)**: what ReqLab
> does, how to use it, how to run and update it, and how it keeps you safe.

> A hostable, Postman-style API client you run yourself. Build, send, and
> inspect HTTP requests from a clean web UI, with collections, environments,
> variables, history, and code generation — backed by a small Node.js server
> that proxies requests so you're never blocked by browser CORS.

ReqLab is a single, dependency-light web app (two runtime dependencies: Express
and undici). No build step, no framework, no account — just `npm start`. Put it
online with an optional password, so only you can use your copy.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/gargshishirr/reqlab)

> 📖 For a full deep-dive — architecture, every file, the request lifecycle,
> the data model, security, and testing — see
> [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md).

---

## ✨ Features

### Request building
- All HTTP methods: **GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS**
- URL bar with method selector and **Send**
- **Query params** editor with enable/disable, two-way synced with the URL
- **Headers** editor (enable/disable rows)
- **Request body**:
  - none
  - **raw** — JSON / Text / XML / HTML / JavaScript (+ one-click **Beautify** for JSON)
  - **x-www-form-urlencoded**
  - **form-data** (multipart, text fields)
- **Authorization**: No Auth · **Bearer Token** · **Basic Auth** · **API Key** (header or query)

### Response viewer
- Status (color-coded), response **time**, and **size**
- **Pretty** (JSON syntax-highlighted) · **Raw** · **Preview** (sandboxed HTML / inline images) · **Headers**
- One-click **Copy** of the response body
- Safe rendering — bodies are HTML-escaped and HTML previews run in a locked `sandbox` iframe (no script execution)

### Organize & reuse
- **Multiple tabs** with an unsaved-changes indicator
- **Collections** — save, open, rename, and delete requests
- **History** — every send is logged and can be re-opened
- **Environments & variables** — define `{{variables}}` and switch environments; variables resolve in the URL, params, headers, body, and auth
- **Code generation** — export the current request as **cURL** or **JavaScript fetch**
- **Import / Export** — ReqLab JSON, plus best-effort **Postman v2** collection import
- **Browser-only storage** — collections/environments/history/tabs are saved in **your own browser** (`localStorage`). They are **never sent to the server**, so tokens/secrets never touch the host (e.g. Render).
- Keyboard shortcut: **⌘/Ctrl + Enter** to send

### Backend
- **Proxy** (`POST /api/proxy`) forwards requests server-side to **bypass CORS** (the same reason the Postman/Insomnia desktop apps work), capturing status, headers, body, timing, and byte size
- **Stateless** — the server writes **nothing** to disk; it's a pure proxy
- Configurable timeout and request/response size limits
- **Optional password** (`REQLAB_PASSWORD`): a sign-in page with a signed, HttpOnly, SameSite=Strict session cookie, sign-out, session expiry and a lockout after repeated wrong passwords
- For public instances: an **SSRF guard** (looks up where a domain really points, checks every redirect hop, and checks the address again when connecting), a **demo-mode allow-list** of hosts, and a **rate limit**
- Browser protections: a strict **Content Security Policy** and other security headers, CSRF checks, and DNS-rebinding protection for local copies
- **Docker** + compose for one-command hosting (non-root, read-only container)

---

## 🏗️ How it works

```mermaid
flowchart LR
    subgraph Browser["🌐 Web UI (public/)"]
        UI[Request builder · Tabs · Collections]
        VARS[Variable substitution + auth/body assembly]
        LS[(localStorage<br/>collections · env · history)]
    end
    subgraph Server["🖥️ Node.js (src/) — stateless"]
        PROXY["/api/proxy — forwards the request"]
    end
    TARGET[(Any HTTP API)]

    UI <--> LS
    UI --> VARS -->|"effective request"| PROXY --> TARGET
    TARGET -->|"status, headers, body, timing"| PROXY --> UI
```

The browser can't call arbitrary third-party APIs directly (CORS). So ReqLab
assembles the final request — resolving `{{variables}}`, applying auth, building
the body — and hands it to the local server, which performs the real request
with Node's `fetch` and returns everything the UI needs to display. The server
keeps **no state**; all your data lives in the browser.

---

## 📁 Project structure

```
reqlab/
├── src/
│   ├── server.js          # starts the server and prints its settings
│   ├── app.js             # Express app: security, sign-in, static site + stateless API
│   ├── config.js          # env-driven configuration
│   └── api/
│       ├── proxy.js       # the request-forwarding proxy (CORS bypass, redirects, size cap)
│       ├── guard.js       # SSRF guard + demo-mode allow-list
│       ├── auth.js        # optional password: sign-in page, session cookie, lockout
│       ├── security.js    # security headers (CSP), CSRF check, DNS-rebinding guard
│       ├── rateLimit.js   # in-memory rate limit for public instances
│       └── routes.js      # health, session and proxy endpoints
├── public/                # the website (no build step)
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── variables.js   # {{var}} resolution
│       ├── codegen.js     # cURL / fetch generation
│       ├── highlight.js   # safe HTML escape + JSON highlighting
│       ├── api.js         # talks to the backend
│       └── app.js         # main UI logic (tabs, requests, collections, …)
├── test/                  # test suite (node:test): proxy, app/auth, UI helpers
├── .github/workflows/     # CI: runs the tests on every push and pull request
├── GUIDE.md               # short user guide
├── Dockerfile · docker-compose.yml
├── render.yaml            # one-click deploy on Render (public demo or private copy)
├── .env.example
└── package.json
```

---

## 🚀 Quick start

**Requirements:** Node.js 22+ (20.18.1 or newer works too).

```bash
npm install
npm start
# → open http://localhost:4000
```

The app opens with a sample request (`GET https://jsonplaceholder.typicode.com/todos/1`).
Click **Send** to see it work.

---

## 🕹️ Using ReqLab

1. **Pick a method and enter a URL** (use `{{baseUrl}}` etc. for variables).
2. Add **Params**, **Headers**, **Authorization**, or a **Body** in the tabs below.
3. Click **Send** (or **⌘/Ctrl+Enter**).
4. Inspect the response: **Pretty / Raw / Preview / Headers**, plus status, time, and size.
5. **Save** the request into a **Collection** for reuse, or grab it later from **History**.
6. Click **`</>`** to copy the request as **cURL** or **fetch**.

### Environments & variables
- Click **Manage** (top bar) to create environments and variables.
- Reference them anywhere as `{{name}}` — they resolve at send time.
- Switch the active environment from the dropdown in the header.

### Import / Export
- **Export** downloads your collections + environments as JSON.
- **Import** accepts a ReqLab export or a **Postman v2** collection (best-effort).

---

## 🔌 API reference

Base URL: `http://localhost:4000/api`

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe (always open) |
| `GET` | `/session` | `{ "auth": false }`, or with a password `{ "auth": true, "user", "expiresAt" }` |
| `POST` | `/proxy` | Forward a request and return the response |

With `REQLAB_PASSWORD` set, everything except `/api/health` and the sign-in page
needs a session: sign in at `/login` (a form post of `password`, plus `username`
if one is set), sign out with `POST /logout`. API calls without a session get
`401 { "error", "signIn": "/login" }`.

> That's the entire API. ReqLab's server is **stateless** — it has no storage
> endpoints. Collections, environments, and history live in your browser's
> `localStorage`, never on the server.

### `POST /api/proxy`

Request body:

```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": { "Authorization": "Bearer …", "Content-Type": "application/json" },
  "body": "{\"name\":\"Ada\"}",
  "timeout": 30000
}
```

Response:

```json
{
  "ok": true,
  "status": 201,
  "statusText": "Created",
  "headers": { "content-type": "application/json" },
  "contentType": "application/json",
  "time": 142,
  "size": 64,
  "body": "{ … }"
}
```

Errors (timeout, DNS failure, blocked host, bad URL) return an `error` field
with an appropriate HTTP status.

Try it with curl:

```bash
curl -X POST http://localhost:4000/api/proxy \
  -H 'Content-Type: application/json' \
  -d '{"method":"GET","url":"https://jsonplaceholder.typicode.com/todos/1"}'
```

With a password, sign in first and keep the cookie:

```bash
curl -c cookies.txt --data-urlencode 'password=your password' https://your-reqlab.example.com/login
curl -b cookies.txt -X POST https://your-reqlab.example.com/api/proxy \
  -H 'Content-Type: application/json' \
  -d '{"method":"GET","url":"https://jsonplaceholder.typicode.com/todos/1"}'
```

---

## ⚙️ Configuration

Copy `.env.example` to `.env` (all optional):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `PROXY_TIMEOUT_MS` | `30000` | Default per-request timeout |
| `PROXY_MAX_TIMEOUT` | `120000` | Upper bound on per-request timeout |
| `MAX_RESPONSE_BYTES` | `26214400` | Max response kept for display (25 MB) |
| `MAX_BODY_BYTES` | `52428800` | Max size of a request sent to ReqLab itself (50 MB) |
| `REQLAB_PASSWORD` | *(empty)* | Turns on the sign-in page for the UI and the API (8+ characters). Empty or `off` = no password |
| `REQLAB_USERNAME` | *(empty)* | Optional user name to ask for as well |
| `SESSION_SECRET` | *(random)* | Signs the session cookie. Set a long random value to stay signed in across restarts |
| `SESSION_HOURS` | `12` | How long a sign-in lasts |
| `BLOCK_PRIVATE_HOSTS` | `false` | Block proxying to localhost/private IPs, including domains that resolve to them, redirects that lead to them, and addresses that change at connect time |
| `ALLOWED_HOSTS` | *(empty)* | Demo mode: only call these hosts (comma separated; `*.example.com` allows subdomains). Empty allows any host. Not used when a password is set |
| `RATE_LIMIT_PER_MINUTE` | `0` | Proxied requests per visitor per minute (`0` = no limit) |
| `RATE_LIMIT_TOTAL_PER_MINUTE` | `0` | Proxied requests per minute for the whole server (`0` = no limit) |
| `CLIENT_IP_HEADER` | *(empty)* | Header your host's proxy sets to the visitor's IP, for the rate limit and the sign-in lockout (`cf-connecting-ip` on Render). Never use one visitors can set themselves |

> There is no data directory to configure — the server stores nothing.

---

## ☁️ Hosting

### Docker (recommended)

```bash
docker compose up --build
# → http://localhost:4000
```

Or:

```bash
docker build -t reqlab .
docker run -p 4000:4000 reqlab
```

No volume is needed — the server is stateless. Compose reads settings from a
`.env` file next to it (copy `.env.example`); if other people can reach your
copy, set `REQLAB_PASSWORD` and `SESSION_SECRET` there. The image runs as a
non-root user and compose keeps the container read-only.

### Render (one click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/gargshishirr/reqlab)

The button uses [`render.yaml`](render.yaml) and asks for `REQLAB_PASSWORD`:

- **Leave it empty (or `off`) for a public demo** on the free plan: the SSRF
  guard is on, the proxy only calls a short list of well-known test APIs
  (`ALLOWED_HOSTS`), and requests are rate limited.
- **Set a password for your own private copy:** every page and API call needs
  a sign-in, and the copy can call any API (`ALLOWED_HOSTS` is not used with a
  password). The SSRF guard stays on, so it still can't reach Render's private
  network. `SESSION_SECRET` is generated for you, so you stay signed in when
  the service restarts.

A free Render service sleeps after 15 idle minutes and takes about a minute to
wake up. See [GUIDE.md](GUIDE.md) for the step-by-step version.

### Any Node host (Render, Railway, Fly.io, a VPS…)

- **Build:** `npm ci --omit=dev`
- **Start:** `npm start`
- The app reads `process.env.PORT`. **No persistent disk is required** — the
  server keeps no state. Your collections/environments/history live in your
  browser, so nothing of yours is written to the host.
- Serve it over **HTTPS**. If your own reverse proxy terminates TLS, have it
  pass the original `Host` header and `X-Forwarded-Proto`, so the session
  cookie is marked `Secure`. Caddy and Traefik do this by default; with nginx,
  add `proxy_set_header Host $host;` and
  `proxy_set_header X-Forwarded-Proto $scheme;`.

> **Where does my data go when I host on Render?** Nowhere on Render. The server
> never writes to disk; your data stays in your browser's `localStorage` on the
> machine you use ReqLab from.

> **If you expose ReqLab beyond your machine,** set `BLOCK_PRIVATE_HOSTS=true`
> and `REQLAB_PASSWORD`. The proxy forwards whatever URL it's given (that's the
> whole point of an API client), so an open instance could be used to reach
> internal services (SSRF) or as a free proxy. The guard looks up every domain
> name and refuses private addresses, checks each redirect hop, and checks the
> address again when it connects. A public instance without a password should
> use `ALLOWED_HOSTS` and the rate limit (as `render.yaml` does). For
> local/personal use you can leave the guard off to test your own `localhost`
> APIs; ReqLab then only answers on `localhost` and IP addresses.

---

## 🧪 Testing

```bash
npm test
```

The suite covers the SSRF guard (IPv6 forms, IPv4-mapped addresses, domains
that resolve to private addresses, redirects to private hosts, addresses that
change between the check and the connection), the demo-mode allow-list, method
and header handling, redirect following (303 → GET, credentials dropped across
sites), the response size cap, the rate limit, and end-to-end proxy tests
against local target servers. It also covers the password option (sign-in,
cookie flags, expiry, tampering, sign-out, lockout, user name, restarts and
password changes), CSRF and DNS-rebinding protection, security headers, the
order of sign-in and body parsing, and the XSS-safe JSON highlighter.

GitHub Actions runs the suite on Node 22 and 24 for every push and pull request
([`.github/workflows/test.yml`](.github/workflows/test.yml)).

---

## 🔐 Security notes

- **The server stores nothing.** Collections, environments, and history live
  only in your browser's `localStorage` — tokens/secrets never reach the host.
- **Optional password.** `REQLAB_PASSWORD` puts the UI and the API behind a
  sign-in page. The session cookie is signed (HMAC-SHA256), `HttpOnly`,
  `SameSite=Strict`, and `Secure` with the `__Host-` prefix behind HTTPS; it
  expires after `SESSION_HOURS`, sign-out ends it on the server too, and
  changing the password ends every session. Passwords are compared in constant
  time, a visitor is locked out for 15 minutes after 5 wrong tries, and the
  password is never logged. Request bodies are only read after sign-in.
- **CSRF and DNS rebinding.** State-changing requests must come from ReqLab's
  own pages (`Sec-Fetch-Site` / `Origin` check). A local copy without a
  password and with private hosts allowed only answers on `localhost` and IP
  addresses, so a website can't rebind its domain to your machine.
- Response bodies are **HTML-escaped** before display (including data from
  imported files); the **Preview** tab renders HTML inside a fully locked
  `sandbox` iframe (no script execution) — so a hostile response can't run code
  in the app. A strict **Content Security Policy** (`script-src 'self'`, no
  outside connections, no framing) and other security headers back this up.
- Only the headers you set are sent to the target API — never ReqLab's own
  cookie or your browser's headers. Hop-by-hop headers (`Host`,
  `Content-Length`, `Connection`, …) are stripped too.
- **SSRF guard.** With `BLOCK_PRIVATE_HOSTS=true`, private addresses are refused
  up front, on every redirect, and again at connect time (the connection only
  goes to addresses that passed the check), which closes the DNS-rebinding gap.
- If you host it publicly, use `BLOCK_PRIVATE_HOSTS` with either a password or
  `ALLOWED_HOSTS` and the rate limit.

---

## 📄 License

MIT.
