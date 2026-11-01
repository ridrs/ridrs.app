# ridrs.app

Cloudflare Workers application for [ridrs.app](https://ridrs.app).

## Project Setup

This project is built using Cloudflare Workers and managed via Wrangler.

### Configuration
- **Worker Name**: `ridrs-app`
- **Connected Domains**:
  - `ridrs.app`
  - `www.ridrs.app`
- **Entrypoint**: `src/index.js`
- **Configuration**: `wrangler.toml`

## Local Development

From the `web` directory:
```bash
npm run dev
# or
wrangler dev
```

## Manual Deployment

From the `web` directory:
```bash
npm run deploy
# or
wrangler deploy
```

## Automated Deployment on Push

Continuous deployment is handled natively via **Cloudflare Workers Builds**:
- Connected to GitHub repository `ridrs/ridrs.app`
- **Root Directory**: `web`
- **Production Branch**: `main`

Pushing to `main` automatically triggers Cloudflare to build and deploy the Worker application.
