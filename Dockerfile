FROM oven/bun:1

WORKDIR /app

# 🔥 IMPORTANT
RUN apt-get update && apt-get install -y ca-certificates

COPY package.json bun.lock ./
RUN bun install

COPY . .

CMD ["bun", "run", "src/main.ts"]