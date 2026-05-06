# Stage 1: Build SP1 prover binary
FROM rust:1.78-slim AS sp1-builder

RUN apt-get update && apt-get install -y curl git pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

# Install SP1 CLI
RUN curl -L https://sp1.succinct.xyz | bash && \
    /root/.sp1/bin/sp1up && \
    cp /root/.sp1/bin/sp1-prove /usr/local/bin/sp1-prove

# Copy circuits and build
WORKDIR /circuits
# Note: carnot-circuits repo must be available at build time
# In CI, mount or COPY the circuits source
# For local builds: docker build --build-context circuits=../carnot-circuits .

# Stage 2: Node.js keeper bot
FROM node:20-alpine AS keeper

WORKDIR /app

# Copy SP1 binary from builder stage
COPY --from=sp1-builder /usr/local/bin/sp1-prove /usr/local/bin/sp1-prove
RUN chmod +x /usr/local/bin/sp1-prove

# Install dependencies
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile --production

# Copy built source
COPY dist/ ./dist/

ENV NODE_ENV=production
ENV SP1_PROVER_BINARY=/usr/local/bin/sp1-prove

EXPOSE 0

CMD ["node", "dist/index.js"]
