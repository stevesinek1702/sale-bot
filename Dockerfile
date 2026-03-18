FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source (v9)
COPY src/ src/
COPY tsconfig.json ./

# Create data directories
RUN mkdir -p data/accounts data/images data/progress

# Copy pre-saved account credentials directly (bypass restore logic)
COPY src/accounts/ data/accounts/

# Copy invite image
COPY data/images/invite.jpg data/images/invite.jpg

# Copy progress (chỉ dùng làm fallback, persistent disk sẽ override)
# KHÔNG copy vào data/progress/ vì persistent disk mount sẽ quản lý
# restoreProgress() trong code sẽ tự copy từ src/progress/ nếu cần

EXPOSE 3000
ENV PORT=3000

CMD ["bun", "src/main.ts"]
