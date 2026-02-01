FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

# Install p7zip for 7z support
RUN apk add --no-cache p7zip

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 30080

# Start server
CMD ["node", "dist/index.js"]

