# 🧪 ReqLab — a lightweight API client

> A hostable, Postman-style API client you run yourself. Build, send, and
> inspect HTTP requests from a clean web UI, with collections, environments,
> variables, history, and code generation — backed by a small Node.js server
> that proxies requests so you're never blocked by browser CORS.

ReqLab is a single, dependency-light web app (one runtime dependency: Express).
No build step, no framework, no account — just `npm start`.

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
- **Persistence** — collections/environments/history saved server-side; open tabs restored from `localStorage`
- Keyboard shortcut: **⌘/Ctrl + Enter** to send

### Backend
- **Proxy** (`POST /api/proxy`) forwards requests server-side to **bypass CORS** (the same reason the Postman/Insomnia desktop apps work), capturing status, headers, body, timing, and byte size
- **Store API** for collections/environments/history (single JSON file)
- Configurable timeout, max response size, and an optional **SSRF guard** for private hosts
- **Docker** + compose for one-command hosting

---

## 🏗️ How it works

```mermaid
flowchart LR
    subgraph Browser["🌐 Web UI (public/)"]
        UI[Request builder · Tabs · Collections]
        VARS[Variable substitution + auth/body assembly]
    end
    subgraph Server["🖥️ Node.js (src/)"]
        PROXY["/api/proxy — forwards the request"]
        STORE["/api/store — collections/env/history"]
    end
    TARGET[(Any HTTP API)]

    UI --> VARS -->|"effective request"| PROXY --> TARGET
    TARGET -->|"status, headers, body, timing"| PROXY --> UI
    UI <-->|persist| STORE
```

The browser can't call arbitrary third-party APIs directly (CORS). So ReqLab
assembles the final request — resolving `{{variables}}`, applying auth, building
the body — and hands it to the local server, which performs the real request
with Node's `fetch` and returns everything the UI needs to display.

---

## 📁 Project structure

```
reqlab/
├── src/
│   ├── server.js          # Express app: static site + API
│   ├── config.js          # env-driven configuration
│   ├── store.js           # JSON file persistence
│   └── api/
│       ├── proxy.js       # the request-forwarding proxy (CORS bypass + SSRF guard)
│       └── routes.js      # proxy + store endpoints
├── public/                # the website (no build step)
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── variables.js   # {{var}} resolution
│       ├── codegen.js     # cURL / fetch generation
│       ├── highlight.js   # safe HTML escape + JSON highlighting
│       ├── api.js         # talks to the backend
│       └── app.js         # main UI logic (tabs, requests, collections, …)
├── test/reqlab.test.js    # backend test suite
├── Dockerfile · docker-compose.yml
├── .env.example
└── package.json
```

---

## 🚀 Quick start

**Requirements:** Node.js 18+ (uses the built-in `fetch`).

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
| `GET` | `/health` | Liveness probe |
| `POST` | `/proxy` | Forward a request and return the response |
| `GET` | `/store` | Get `{ collections, environments, history }` |
| `PUT` | `/store` | Merge a partial update of the store |

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
| `BLOCK_PRIVATE_HOSTS` | `false` | Block proxying to localhost/private IPs |
| `DATA_DIR` | `./data` | Where the store is persisted |

---

## ☁️ Hosting

### Docker (recommended)

```bash
docker compose up --build
# → http://localhost:4000   (data persisted in a named volume)
```

Or:

```bash
docker build -t reqlab .
docker run -p 4000:4000 -v reqlab-data:/app/data reqlab
```

### Any Node host (Render, Railway, Fly.io, a VPS…)

- **Build:** `npm install`
- **Start:** `npm start`
- The app reads `process.env.PORT`. Mount a persistent disk at `DATA_DIR` to keep
  collections across restarts.

> **If you expose ReqLab publicly,** set `BLOCK_PRIVATE_HOSTS=true`. The proxy
> forwards whatever URL it's given (that's the whole point of an API client), so
> an open instance could be used to reach internal services (SSRF). Blocking
> private hosts mitigates this; for local/personal use you can leave it off so
> you can test your own `localhost` APIs. Consider putting a public deployment
> behind authentication.

---

## 🧪 Testing

```bash
npm test
```

The suite covers the SSRF host classifier, header sanitization, the persistent
store (including history capping), and an end-to-end proxy + store integration
test against a local target server.

---

## 🔐 Security notes

- Response bodies are **HTML-escaped** before display; the **Preview** tab renders
  HTML inside a fully locked `sandbox` iframe (no script execution) — so a hostile
  response can't run code in the app.
- Hop-by-hop headers (`Host`, `Content-Length`, `Connection`, …) are stripped
  before forwarding.
- The proxy is intended for **trusted, local/personal use**, like every API
  client. Use `BLOCK_PRIVATE_HOSTS` and an auth layer if you host it publicly.

---

## 📄 License

MIT.
