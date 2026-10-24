FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TMPDIR=/tmp

# ffmpeg does the DASH merge (separate video + audio streams) and the MP3
# extraction. --no-install-recommends keeps the image near 130 MB instead of
# pulling in the X11 and font stacks that the default ffmpeg package drags along.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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
