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

A GitHub Actions workflow is provided at `.github/workflows/deploy.yml`.

To enable automatic deployment upon pushing to the `main` branch via GitHub Actions:
1. Create a Cloudflare API Token with **Worker Scripts: Edit** and **Worker Routes: Edit** permissions in the [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens).
2. In your GitHub repository settings, add the repository secrets:
   - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API Token
   - `CLOUDFLARE_ACCOUNT_ID`: `3ef2de5c8cef25f8cb24ae089bd89274`

Alternatively, you can enable native **Workers Builds** directly in Cloudflare:
- Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) > **Workers & Pages** > **ridrs-app** > **Settings** > **Builds** and link your GitHub repository.
