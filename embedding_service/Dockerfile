# Trigger Railway rebuild with current service settings
FROM python:3.15.0-slim-trixie@sha256:f5b92f2a669a4c347044f29367f31983280b648250ca94dea66f98c53bc87e58 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    HF_HUB_DISABLE_TELEMETRY=1 \
    EMBEDDING_MODEL_CACHE_DIR=/models \
    EMBEDDING_MODEL_LOCAL_FILES_ONLY=true

RUN python -m venv /opt/venv \
    && groupadd --system --gid 10002 repolume-embeddings \
    && useradd --system --uid 10002 --gid repolume-embeddings --home-dir /app --shell /usr/sbin/nologin repolume-embeddings \
    && mkdir --parents /app /models

WORKDIR /app

COPY requirements.lock ./requirements.lock
RUN python -m pip install --no-cache-dir --require-hashes --requirement requirements.lock

COPY app ./app
RUN python -m app.download_model \
    && chown --recursive 10002:10002 /app /models

USER 10002:10002

EXPOSE 8100

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100", "--no-access-log"]
