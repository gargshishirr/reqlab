# ReqLab — user guide

A short, plain guide to using and running ReqLab. For the full technical details, see the
[README](README.md) and [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md).

## Contents

- [What it is](#what-it-is)
- [Features](#features)
- [How to use](#how-to-use)
- [How to maintain](#how-to-maintain)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)

## What it is

ReqLab is a small app for testing web APIs, like a mini Postman that runs in your browser. You type a
URL, press **Send**, and see the answer.

A browser can't call most APIs directly (it blocks them for safety, a rule called CORS). So ReqLab
comes with a tiny server that sends the request for you and hands back the answer.

## Features

- Send any request: GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS.
- Add query params, headers, a body (JSON, text, form) and login details (Bearer token, Basic auth or
  an API key).
- See the answer nicely: status, time, size, coloured JSON, raw text, headers, and a safe preview of
  HTML pages and images.
- Save requests in **collections**, and find old ones in **history**.
- Use **environments** and `{{variables}}` to switch between, say, test and live servers.
- Turn any request into **cURL** or **JavaScript fetch** code.
- **Import and export** your work, including Postman collections.
- Your data stays in **your browser**. The server stores nothing.
- An optional **password**, so only you can use your online copy.

## How to use

### Send a request

1. Pick a method (like GET) and type the URL.
2. Add **Params**, **Headers**, **Authorization** or a **Body** in the tabs under the URL, if needed.
3. Click **Send**, or press **Ctrl + Enter** (**⌘ + Enter** on a Mac).

The answer shows up at the bottom. Use the **Pretty**, **Raw**, **Preview** and **Headers** tabs to look
at it in different ways, and **Copy** to copy the body.

### Collections and history

Click **Save** to keep a request in a collection. Your collections are on the left; click a request to
open it in a new tab.

Every request you send also goes into **History** (the second tab on the left), so you can open it
again later.

### Environments and variables

Click **Manage** at the top to make an environment, such as "Test", and add variables like
`baseUrl = https://api.example.com`. Then write `{{baseUrl}}/users` in the URL.

Pick the environment from the list at the top. Variables work in the URL, params, headers, body and
login details, and are filled in when you click **Send**.

### Code generation

Click the **`</>`** button next to the URL. Choose **cURL** or **JavaScript fetch** and click **Copy**.

### Import and export

**Export** downloads your collections and environments as one JSON file. **Import** loads a ReqLab
export or a Postman (v2) collection.

Exporting is also how you back up your work, or move it to another browser or computer.

## How to maintain

### Run it on your computer

You need [Node.js](https://nodejs.org) 22 or newer, and Git.

```bash
git clone https://github.com/gargshishirr/reqlab.git
cd reqlab
npm install
npm start
```

Open <http://localhost:4000>. Press **Ctrl + C** in the terminal to stop it.

### Run it with Docker

```bash
docker compose up --build -d
```

Open <http://localhost:4000>. Stop it with `docker compose down`, and see what it prints with
`docker compose logs -f`.

### Put it online with Render

Click the **Deploy to Render** button in the [README](README.md) and follow the steps. Render asks for
`REQLAB_PASSWORD`; what you type decides which kind of copy you get:

- **Public demo:** leave it empty (or type `off`). Anyone can use it, but it only calls a few test
  APIs and is rate limited, so strangers can't misuse it.
- **Your own private copy:** type a long password (at least 8 characters, 12 or more is better). You
  sign in first, and then you can call any API.

Render gives your copy a web address with HTTPS. A free copy falls asleep after about 15 minutes
without visitors, so the first visit after that takes about a minute.

To add or change the password later, open your service in the
[Render dashboard](https://dashboard.render.com), go to **Environment**, set `REQLAB_PASSWORD`, then
save and deploy. Changing the password signs everyone out.

### Update to a new version

- **On your computer:** stop ReqLab, then run `git pull`, `npm install` and `npm start`.
- **Docker:** run `git pull`, then `docker compose up --build -d`.
- **Render:** it updates by itself whenever the GitHub repository changes. You can also click
  **Manual Deploy** in the dashboard.

### Settings

On your computer or with Docker, copy the example file and edit it:

```bash
cp .env.example .env
```

Restart ReqLab after a change (with Docker, run `docker compose up -d` again).

On Render, change settings on the service's **Environment** page instead. If a setting is also written
in `render.yaml`, change it there too, or Render puts the old value back when that file changes.

The most useful settings:

| Setting | What it does |
| --- | --- |
| `REQLAB_PASSWORD` | Turns on the sign-in page. Empty means no password. |
| `REQLAB_USERNAME` | Also asks for this user name (optional). |
| `SESSION_SECRET` | Keeps you signed in when the server restarts. Use a long random value. |
| `SESSION_HOURS` | How long a sign-in lasts (default 12 hours). |
| `BLOCK_PRIVATE_HOSTS` | `true` stops the server from calling private network addresses. Use it online. |
| `ALLOWED_HOSTS` | Public demo only: the proxy calls just these hosts. Not used with a password. |
| `RATE_LIMIT_PER_MINUTE` | Requests each visitor may send per minute (0 = no limit). |
| `PORT` | The port on your computer (default 4000). |

Every setting is explained in [`.env.example`](.env.example). To make a `SESSION_SECRET`, run:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Check that it works

```bash
npm test
curl http://localhost:4000/api/health
```

The first runs the automatic tests. The second asks a running ReqLab if it is healthy. GitHub also runs
the tests for every change (see the **Actions** tab of the repository).

## Security and privacy

### Where your data lives

Your collections, environments and history are saved in **your browser** only. The server keeps
nothing, so a hosted copy (like on Render) never stores your tokens.

Clearing your browser data deletes them, and a different browser or web address starts empty. Use
**Export** to keep a backup.

### What the server sees

Each request you send passes through the ReqLab server on its way to the API, including any tokens in
it. The server forwards it and forgets it: nothing is saved or logged.

### The private-network guard

With `BLOCK_PRIVATE_HOSTS=true`, the server refuses to call addresses inside its own network, like
`localhost`, `192.168.x.x` or cloud metadata services. It checks every redirect, and checks again at
the moment it connects. Always keep it on for a copy that is online (the Render setup does).

On your own computer you can leave it off to test APIs running there. Then ReqLab only answers at
`localhost` or an IP address, which stops websites from tricking it into calling your network.

### The password

With `REQLAB_PASSWORD` set, every page and API call needs you to sign in first; only the health check
stays open. Signing in sets a secure cookie that ends after 12 hours, or when you click **Sign out**.

After 5 wrong passwords, that visitor must wait 15 minutes. Changing the password signs everyone out.

### What to keep secret

- Your `REQLAB_PASSWORD` and `SESSION_SECRET`.
- Your `.env` file. It is never added to Git or to the Docker image; keep it that way.
- Exported files. They contain your variables, and so maybe your tokens.

Use HTTPS when your copy is online, so the password can't be read on the way. Render does this for you.

## Troubleshooting

**"Requests to … are blocked by this server"**
The public demo only calls its test APIs, or the private-network guard stopped a private address. Use
your own copy (on your computer, or online with a password) to call other APIs.

**"ReqLab blocked this request … only answers on localhost or an IP address"**
You opened a copy that has no password through a domain name. Open it at `http://localhost:4000`, or
set `REQLAB_PASSWORD`.

**"Too many wrong attempts"**
Wait 15 minutes and try again. On Render, check the password on the service's **Environment** page.

**You are signed out after a restart**
Set `SESSION_SECRET` to a long random value. The Render setup already does this.

**ReqLab won't start: "REQLAB_PASSWORD is too short"**
Use at least 8 characters.

**"Too many requests through this server"**
You hit the rate limit. Wait a minute, or raise `RATE_LIMIT_PER_MINUTE` on your own copy.

**"The request is too large" or "Response truncated"**
Raise `MAX_BODY_BYTES` (what you send) or `MAX_RESPONSE_BYTES` (what you get back).

**An online copy can't reach `localhost` or my home network**
That is on purpose. Run ReqLab on your own computer to test APIs that run there.

**Port 4000 is already in use**
Start it on another port: `PORT=4001 npm start`.

**My collections are gone**
They live in one browser at one web address. Open ReqLab where you made them, or use **Export** and
**Import** to move them.
