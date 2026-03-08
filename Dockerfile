FROM oven/bun:1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dnsutils \
    git \
    iproute2 \
    iputils-ping \
    netcat-openbsd \
    python3 \
    python3-pip \
    python3-venv \
    wget \
  && python3 -m venv /app/.python_env \
  && /app/.python_env/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
  && mkdir -p /app/.run/kairo \
  && git config --global --add safe.directory /app \
  && git init /app \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN git -C /app add -A \
  && git -C /app -c user.name="kairo-agent" -c user.email="kairo-agent@local" commit -m "chore: initial snapshot"

ENV NODE_ENV=production
ENV PYTHON_ENV_PATH=/app/.python_env
ENV PATH="/app/.python_env/bin:${PATH}"
ENV KAIRO_RUNTIME_DIR=/app/.run/kairo
ENV KAIRO_IPC_SOCKET=/app/.run/kairo/kernel.sock
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
