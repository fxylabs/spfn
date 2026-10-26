# Production Dockerfile for SPFN
FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN corepack enable pnpm

# Copy dependency files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Copy source code
COPY . .

# Build application
RUN pnpm run spfn:build

# Remove dev dependencies (optional, reduces image size)
RUN pnpm prune --prod

# Environment
ENV NODE_ENV=production

# Expose ports. Docker cannot read spfn.config.js, so these two numbers are the
# one place they are repeated — keep them in step with `ports` in that file, or
# set NEXT_PORT / SPFN_PORT here and in the compose file instead.
EXPOSE 3790 8790

# Health check. Falls back to the same default the framework uses, so setting
# SPFN_PORT alone moves both the server and its probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.SPFN_PORT||8790)+'/_core/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["pnpm", "run", "spfn:start"]
