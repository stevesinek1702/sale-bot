FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Create data directories
RUN mkdir -p data/accounts data/images data/progress

# Copy pre-saved account credentials directly (bypass restore logic)
COPY src/accounts/ data/accounts/

# Copy invite image
COPY data/images/invite.jpg data/images/invite.jpg

# Copy progress
COPY src/progress/ data/progress/

EXPOSE 3000
ENV PORT=3000

CMD ["bun", "src/main.ts"]
