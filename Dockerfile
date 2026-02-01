FROM node:20-slim AS builder

# Install p7zip for 7z support (needed during build for potential checks)
RUN apt-get update && apt-get install -y p7zip-full && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy server package files
COPY app/server/package.json app/server/package-lock.json ./app/server/

# Install dependencies (including devDependencies for build)
WORKDIR /app/app/server

# Configure npm to use Chinese mirror for sqlite3 binary via environment variable
ENV npm_config_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/sqlite3/

# Fix ETXTBSY error with esbuild: install with retry and ignore scripts first, then run postinstall
# This avoids the "Text file busy" error when esbuild binary is being validated during install
RUN npm install --ignore-scripts && \
    npm rebuild esbuild --no-save || true && \
    npm run postinstall 2>/dev/null || true

# Copy TypeScript config and source
COPY app/server/tsconfig.json ./
COPY app/server/src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-slim

# Install p7zip for 7z support
RUN apt-get update && apt-get install -y p7zip-full && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy server package files
COPY app/server/package.json app/server/package-lock.json ./server/

# Install only production dependencies
WORKDIR /app/server

# Configure npm to use Chinese mirror for sqlite3 binary via environment variable
ENV npm_config_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/sqlite3/

# Fix ETXTBSY error: install with ignore-scripts first, then rebuild esbuild if needed
RUN npm ci --only=production && \
    npm rebuild esbuild --no-save 2>/dev/null || true

# Copy built files from builder
COPY --from=builder /app/app/server/dist ./dist

# Copy static frontend files
WORKDIR /app
COPY app/www ./www

# Generate version.json file (required by backend/frontend)
# Build arguments for version info (can be passed during build: --build-arg GIT_SHA=xxx)
ARG GIT_SHA=unknown
ARG BUILD_TIME
# Get version from package.json or use default
RUN VERSION=$(node -p "require('./server/package.json').version" 2>/dev/null || echo "1.0.0") && \
    BUILD_TIME_VALUE="${BUILD_TIME:-$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%S%z")}" && \
    echo "{\"version\":\"${VERSION}\",\"buildTime\":\"${BUILD_TIME_VALUE}\",\"git\":\"${GIT_SHA}\"}" > ./www/version.json && \
    echo "Generated version.json: version=${VERSION}, buildTime=${BUILD_TIME_VALUE}, git=${GIT_SHA}"

# Set environment variables
ENV NODE_ENV=production

# Expose port
EXPOSE 30080

# Start server (from server directory so dist/index.js can find www at ../www)
WORKDIR /app/server
CMD ["node", "dist/index.js"]
