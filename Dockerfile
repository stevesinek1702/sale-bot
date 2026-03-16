FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source (bust cache v8 - fix restore timing)
COPY src/ src/
COPY tsconfig.json ./

# Create data directories
RUN mkdir -p data/accounts data/images data/progress

# Copy invite image
COPY data/images/invite.jpg data/images/invite.jpg

# Expose port
EXPOSE 3000
ENV PORT=3000

CMD ["bun", "src/main.ts"]
