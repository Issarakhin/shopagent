# Deployment

## Vercel frontend

This repository is pinned to npm and Node.js 20. `vercel.json` builds only the Vite client.

1. Push all files, including `package-lock.json`, `.npmrc`, and `vercel.json`.
2. Confirm that `bun.lock`, `pnpm-lock.yaml`, and `yarn.lock` are not in the repository.
3. In Vercel, set Node.js to 20.x and redeploy without the previous build cache.
4. Add `VITE_API_BASE_URL` pointing to the deployed Heroku backend.

## Heroku backend

The included `Procfile` runs `npm start`. Deploy the same repository to Heroku and configure server environment variables there.

The normal `npm run build` command creates both the Vite client and `dist/server.cjs` for Heroku. Vercel overrides this using `npm run build:client`.
