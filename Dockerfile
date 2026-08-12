# ── Stage 1: Build ──
FROM node:24-alpine AS build

WORKDIR /app

# Copy package files for both backend and frontend
COPY github-control-hub/backend/package*.json github-control-hub/backend/
COPY github-control-hub/frontend/package*.json github-control-hub/frontend/

# Install all dependencies (including devDependencies for building)
RUN cd github-control-hub/backend && npm install
RUN cd github-control-hub/frontend && npm install

# Copy source code
COPY github-control-hub/backend github-control-hub/backend
COPY github-control-hub/frontend github-control-hub/frontend

# Build backend (TypeScript → dist/)
RUN cd github-control-hub/backend && npx tsc

# Build frontend (Vite → dist/)
RUN cd github-control-hub/frontend && npm run build

# ── Stage 2: Production ──
FROM node:24-alpine

WORKDIR /app

# Copy backend compiled output and package files
COPY --from=build /app/github-control-hub/backend/dist github-control-hub/backend/dist
COPY --from=build /app/github-control-hub/backend/package*.json github-control-hub/backend/

# Copy frontend built output
COPY --from=build /app/github-control-hub/frontend/dist github-control-hub/frontend/dist

# Install production-only backend dependencies
RUN cd github-control-hub/backend && npm install --omit=dev

# Default environment
ENV PORT=4321
ENV NODE_ENV=production

EXPOSE 4321

# Run as non-root user (node:24-alpine ships with a 'node' user)
RUN chown -R node:node /app
USER node

# Run the standalone server
CMD ["node", "github-control-hub/backend/dist/standalone.js"]
