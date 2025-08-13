FROM node:20-bookworm-slim AS builder

ENV NODE_ENV=production
WORKDIR /usr/src/app

# System deps required to compile mediasoup native addons
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

# Install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source
COPY . .

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /usr/src/app

# Bring in built app and node_modules from builder stage
COPY --from=builder /usr/src/app /usr/src/app

# Expose HTTP/WebSocket and mediasoup UDP/TCP ports
EXPOSE 8425/tcp
EXPOSE 12825/udp

# Start the application
CMD ["node", "app.js"]
