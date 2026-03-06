FROM oven/bun:1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
  && python3 -m venv /app/.python_env \
  && /app/.python_env/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PYTHON_ENV_PATH=/app/.python_env
ENV PATH="/app/.python_env/bin:${PATH}"
ENV KAIRO_RUNTIME_DIR=/app/.run/kairo
ENV KAIRO_IPC_SOCKET=/app/.run/kairo/kernel.sock
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
