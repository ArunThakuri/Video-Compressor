FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TMPDIR=/tmp

# ffmpeg does the DASH merge (separate video + audio streams) and the MP3
# extraction. --no-install-recommends keeps the image near 130 MB instead of
# pulling in the X11 and font stacks that the default ffmpeg package drags along.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# Deno is a hard requirement, not a nicety. yt-dlp solves YouTube's
# JavaScript challenges to obtain formats, and deno is its default runtime; with
# no runtime present, extraction dies at "No video formats found" even when the
# cookies are perfectly valid. Verified by running this image on a home IP with
# working cookies: same failure, cured by adding deno.
ARG DENO_VERSION=2.9.8
RUN curl -fsSL -o /tmp/deno.zip \
      "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
 && unzip -q -o /tmp/deno.zip -d /usr/local/bin \
 && rm -f /tmp/deno.zip \
 && chmod 0755 /usr/local/bin/deno \
 && deno --version

WORKDIR /app

# Copied separately so the dependency layer is cached across app.py edits.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Render routes to $PORT. Run unprivileged; nothing here needs root.
ENV PORT=8080
EXPOSE 8080

RUN useradd --create-home --uid 10001 app \
 && mkdir -p /tmp \
 && chown -R app:app /app /tmp
USER app

CMD ["python3", "app.py"]
