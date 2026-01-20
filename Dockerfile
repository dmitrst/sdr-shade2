# Stage 1: Builder (full Node env for building)
FROM --platform=linux/arm64 node:20-bookworm-slim AS builder

# Set workdir
WORKDIR /app

# ARG for serial (passed during build)
ARG SERIAL

# Copy package files first for caching
COPY package*.json ./

# Install tools and deps (cached layer)
RUN apt-get update && apt-get install -y build-essential python3 && \
    npm install -g @yao-pkg/pkg && \
    npm install --prefer-offline --no-audit --no-fund

# Copy the rest of the project (including code with hardcoded secret)
COPY . .

# Generate config.json using provided SERIAL and hardcoded secret (run as Node script)
RUN echo "const fs = require('fs'); const crypto = require('crypto'); const BINDING_SECRET = 'f87fd1374ae44f4ecbb072c1959dec13605b7b05711cbee9b4e3fadb702cf10a'; const serial = '${SERIAL}'; const hash = crypto.createHash('md5').update(serial + BINDING_SECRET).digest('hex'); fs.writeFileSync('config.json', JSON.stringify({ key: hash }, null, 2));" > generate-config.js && \
    node generate-config.js && \
    rm generate-config.js  # Clean up temp script

# Build everything (esbuild + pkg)
RUN npm run build-all > debug.log 2>&1

# Stage 2: Slim extractor (only copy artifacts)
FROM --platform=linux/arm64 busybox:latest

WORKDIR /extract

# Copy built artifacts from builder
COPY --from=builder /app/sdr-server .
COPY --from=builder /app/debug.log .
COPY --from=builder /app/config.json .

CMD ["tail", "-f", "/dev/null"]