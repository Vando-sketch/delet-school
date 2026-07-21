# Multi-stage Dockerfile for teams-task-agent receiver and worker services
# Both services use the same image with different entrypoint commands (supplied via docker-compose)

# === Build stage ===
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies (all, including dev)
# NOTE: Once package-lock.json is committed to the repo, switch to `npm ci` instead of `npm install`
#       for reproducible, locked builds in Docker
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Compile TypeScript to JavaScript
RUN npm run build

# === Runtime stage ===
FROM node:20-alpine

WORKDIR /app

# Create non-root user to run the application
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Copy package files from builder
COPY package.json package-lock.json* ./

# Install only production dependencies
# NOTE: Once lockfile is committed, switch to `npm ci --omit=dev`
RUN npm install --omit=dev

# Copy compiled application from builder
COPY --from=builder /app/dist ./dist

# Change ownership to non-root user
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port (actual port is configured via environment variable in runtime)
EXPOSE 3000

# No CMD or ENTRYPOINT here — the command is supplied via docker-compose's `command:` field
# This allows both receiver (npm run start:receiver) and worker (npm run start:worker) to use the same image
