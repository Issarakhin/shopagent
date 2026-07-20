# Backend container for Heroku (container stack) deploys of server.ts.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching. Dev dependencies are
# needed for the build (vite, esbuild), so install everything here.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source and build the client (dist/) and server bundle
# (dist/server.cjs).
COPY . .
RUN npm run build

# Serve production static assets and the API. The server binds process.env.PORT,
# which Heroku injects at runtime.
ENV NODE_ENV=production
CMD ["npm", "start"]
