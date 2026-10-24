# Companion download server

`download.html` cannot fetch video by itself — browsers are blocked from
speaking YouTube's, TikTok's and Facebook's protocols, and `yt-dlp` is a
program, not a library. So this small service runs `yt-dlp` and streams the
finished file back to the page.

It stores nothing: each job downloads to a temp directory, streams that file
to the browser, then deletes it.

| Endpoint | Does |
|---|---|
| `GET /health` | yt-dlp / ffmpeg version — what the page's status pill polls |
| `POST /api/info` `{"url": "…"}` | title, uploader, duration, thumbnail, available heights |
| `GET /api/download?url=…&mode=…` | the file, as `Content-Disposition: attachment` |

Modes: `best` (≤1080p), `720`, `480`, `audio` (MP3).

---

## Deploy to Render (free)

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, pick the repository. It reads `render.yaml`
   at the root and builds `backend/Dockerfile`.
3. When it finishes, copy the service URL — `https://<name>.onrender.com`.
4. Open the GitHub Pages site, go to **Download**, and paste that URL into the
   connect panel. It is remembered in `localStorage`, so it is a one-time step
   per device.

To ship the URL in the page instead, set `DEFAULT_API` near the top of
`download.html`'s script to the same value.

### Auto-deploy does not work for a public-repo service

When the service is created from a **public** repo — the path that avoids
authorising Render's GitHub app — Render disables auto-deploy for it. Pushing to
`main` therefore does **not** rebuild the service. After any change under
`backend/`, use **Manual Deploy → Deploy latest commit** on the service page.

Connecting the GitHub app would restore auto-deploy, at the cost of granting
Render access to your repositories.

### First request is slow

The free plan sleeps after 15 minutes with no traffic. The next request wakes
it, which takes about a minute. The page says so and retries rather than
calling it an error.

### YouTube blocks datacenter IPs

Measured on this deployment: **TikTok works** (802 KB, 23.5 s, valid MP4
verified end to end), and **YouTube does not** — it answers with
`Failed to extract any player response`, which is its bot check rather than a
fault in the request. Alternate `player_client` values were tried
(`tv`, `android_vr`, `web_embedded`, `web_safari`) and made no difference from
Render's address. `YTDLP_COOKIES` is the documented fix; without it, expect
YouTube links to fail while every other supported site works.

---

## Run it locally

```bash
cd backend
py -3.12 -m pip install -r requirements.txt
py -3.12 app.py                 # listens on :8080
```

Then open `download.html` and connect it to `http://127.0.0.1:8080`.
`file://` will not work for this page — the browser refuses cross-origin
`fetch` from a null origin — so serve the folder:

```bash
py -m http.server 8000 --directory .
```

and use `http://127.0.0.1:8000/download.html`.

### Docker

```bash
docker build -t mp4dl backend
docker run -p 8080:8080 mp4dl
```

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | set by Render |
| `ALLOWED_HOSTS` | a 20-site list | comma-separated domains; subdomains match |
| `ALLOWED_ORIGINS` | `*` | CORS for `/health` and `/api/info` |
| `API_TOKEN` | unset | when set, requests need `?token=` or a Bearer header |
| `MAX_FILESIZE_MB` | `400` | per-stream cap |
| `MAX_CONCURRENT` | `2` | simultaneous downloads; extra requests get a 503 |
| `RATE_LIMIT` / `RATE_WINDOW` | `30` / `600` | requests per IP per window |
| `YTDLP_COOKIES` | unset | `cookies.txt` contents (plain or base64) |
| `YTDLP_EXTRA_ARGS` | unset | extra yt-dlp flags, space-separated |

### Why `ALLOWED_HOSTS` exists

Without it this is an open proxy: anyone who finds the URL can make your
server download anything, on your bandwidth and your free-tier quota. The
default list covers the sites the page advertises. Widen it deliberately.

`API_TOKEN` is the control that actually works against a stranger — the page
prompts for it when the server answers 401, and keeps it in `localStorage`.

### When YouTube says "Sign in to confirm you're not a bot"

Datacenter IPs are challenged far more than home connections. The fix is a
cookie jar from a signed-in session:

```bash
# produce cookies.txt with a browser extension exporting Netscape format,
# then base64 it so the newlines survive an env var
base64 -w0 cookies.txt
```

Set `YTDLP_COOKIES` to that output. The variable holds a live session, so set
it in the host's dashboard (a `sync: false` secret), never in `render.yaml`.

`YTDLP_EXTRA_ARGS` is the escape hatch for the same problem —
`--extractor-args youtube:player_client=web_safari` is a common one — but it
changes as YouTube changes, so it is not a default here.

---

## Keeping it working

`yt-dlp` extractors break when a site changes. That is not a bug in this
server, and the fix is a rebuild against a newer release:

```bash
# locally
py -3.12 -m pip install -U yt-dlp

# or in the container: bump backend/requirements.txt and redeploy
```

"Video unavailable" almost always means the extractor is stale, not that the
video is gone.
