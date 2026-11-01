export default {
  async fetch(request, env, ctx) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ridrs.app - Hello World</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f172a;
      --card-bg: rgba(255, 255, 255, 0.04);
      --border: rgba(255, 255, 255, 0.1);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at 50% 20%, #1e293b 0%, var(--bg) 100%);
      color: var(--text-main);
      padding: 1.5rem;
    }
    .container {
      max-width: 540px;
      width: 100%;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 2.5rem 2rem;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(12px);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 500;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: var(--accent);
      margin-bottom: 1.5rem;
    }
    .badge::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 8px #22c55e;
    }
    h1 {
      font-size: 2.5rem;
      font-weight: 800;
      letter-spacing: -0.025em;
      margin-bottom: 0.75rem;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: var(--text-muted);
      font-size: 1.1rem;
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    .info-box {
      background: rgba(0, 0, 0, 0.25);
      border-radius: 12px;
      padding: 1rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
      color: #cbd5e1;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      text-align: left;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
    }
    .info-label {
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">Cloudflare Workers • Active</div>
    <h1>Hello World</h1>
    <p>Welcome to <strong>ridrs.app</strong>! Your Cloudflare Worker application is successfully up and running.</p>
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Domain</span>
        <span>ridrs.app</span>
      </div>
      <div class="info-row">
        <span class="info-label">Runtime</span>
        <span>Cloudflare Workers</span>
      </div>
    </div>
  </div>
</body>
</html>`;

    return new Response(html, {
      headers: {
        "content-type": "text/html;charset=UTF-8",
        "cache-control": "no-cache",
      },
    });
  },
};
