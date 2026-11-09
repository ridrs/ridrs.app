import { route, scheduled } from "./router.js";

export { MailboxHub } from "./hub.js";

export default {
  async fetch(request, env, ctx) {
    const routed = await route(request, env);
    if (routed) return routed;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RIDRS // The Open-Source Crowd-Coded Cycling Platform</title>
  <meta name="description" content="RIDRS is the ultimate open source, extendable, crowd-coded cycling and indoor cycling platform. Break free from walled gardens.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:ital,wght@0,400;0,600;0,700;1,700&family=JetBrains+Mono:wght@400;600;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #07090e;
      --surface: #0d121c;
      --surface-border: rgba(56, 189, 248, 0.18);
      --accent-neon: #00f0ff;
      --accent-volt: #ccff00;
      --accent-glow: rgba(0, 240, 255, 0.35);
      --text: #f1f5f9;
      --text-muted: #8b9bb4;
      --mono: 'JetBrains Mono', monospace;
      --display: 'Chakra Petch', sans-serif;
      --sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      min-height: 100vh;
      overflow-x: hidden;
      position: relative;
      background-image: 
        radial-gradient(ellipse 80% 50% at 50% -20%, rgba(0, 240, 255, 0.15), transparent),
        radial-gradient(circle at 80% 90%, rgba(204, 255, 0, 0.08), transparent);
    }

    /* Ambient motion grid */
    .motion-canvas {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 0;
      opacity: 0.35;
    }

    .wrapper {
      position: relative;
      z-index: 1;
      max-width: 1200px;
      margin: 0 auto;
      padding: 1.5rem 1.5rem 4rem;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    /* Telemetry HUD top bar */
    .hud-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.85rem 1.25rem;
      background: rgba(13, 18, 28, 0.85);
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      backdrop-filter: blur(16px);
      margin-bottom: 3.5rem;
      font-family: var(--mono);
      font-size: 0.8rem;
      letter-spacing: 0.05em;
    }

    .hud-brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .hud-logo {
      font-family: var(--display);
      font-weight: 700;
      font-size: 1.2rem;
      font-style: italic;
      color: #fff;
      letter-spacing: 0.1em;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .hud-logo span {
      color: var(--accent-neon);
    }

    .hud-status-dot {
      width: 8px;
      height: 8px;
      background: var(--accent-volt);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--accent-volt);
      animation: pulse-dot 1.5s infinite ease-in-out;
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.8); }
    }

    .hud-telemetry {
      display: flex;
      gap: 1.5rem;
    }

    .telemetry-item {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .telemetry-label {
      color: var(--text-muted);
    }

    .telemetry-value {
      color: var(--accent-neon);
      font-weight: 600;
    }

    @media (max-width: 768px) {
      .hud-telemetry { display: none; }
      .hud-bar { margin-bottom: 2rem; }
    }

    /* Hero Section */
    .hero {
      text-align: center;
      padding: 2.5rem 1rem 4rem;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .tag-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 1rem;
      border-radius: 100px;
      background: rgba(0, 240, 255, 0.08);
      border: 1px solid rgba(0, 240, 255, 0.3);
      color: var(--accent-neon);
      font-family: var(--mono);
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 2rem;
    }

    .hero-title {
      font-family: var(--display);
      font-size: clamp(2.5rem, 7vw, 5.5rem);
      font-weight: 700;
      line-height: 1.05;
      text-transform: uppercase;
      font-style: italic;
      letter-spacing: -0.01em;
      max-width: 1000px;
      margin-bottom: 1.75rem;
    }

    .hero-title .gradient-text {
      background: linear-gradient(135deg, #ffffff 10%, var(--accent-neon) 60%, var(--accent-volt) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: inline-block;
    }

    .hero-title .stroke-text {
      color: transparent;
      -webkit-text-stroke: 1.5px rgba(255, 255, 255, 0.7);
    }

    .hero-description {
      font-size: clamp(1.1rem, 2vw, 1.45rem);
      color: var(--text-muted);
      max-width: 760px;
      line-height: 1.6;
      font-weight: 400;
      margin-bottom: 2.5rem;
    }

    .hero-description strong {
      color: #fff;
      font-weight: 600;
    }

    /* Live Telemetry Dial Widget */
    .dial-console {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.25rem;
      max-width: 680px;
      width: 100%;
      margin: 0 auto 3.5rem;
    }

    .dial-card {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 14px;
      padding: 1.25rem 1rem;
      position: relative;
      overflow: hidden;
    }

    .dial-card::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--accent-neon), transparent);
    }

    .dial-metric {
      font-family: var(--mono);
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      margin-bottom: 0.35rem;
      letter-spacing: 0.05em;
    }

    .dial-number {
      font-family: var(--display);
      font-size: 2.2rem;
      font-weight: 700;
      color: #fff;
      font-style: italic;
    }

    .dial-unit {
      font-size: 0.9rem;
      color: var(--accent-volt);
      font-style: normal;
      margin-left: 0.2rem;
    }

    @media (max-width: 640px) {
      .dial-console {
        grid-template-columns: 1fr;
        gap: 0.75rem;
      }
    }

    /* Features Grid */
    .features-heading {
      font-family: var(--display);
      font-size: 1.1rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--accent-neon);
      text-align: center;
      margin-bottom: 2rem;
      font-style: italic;
    }

    .grid-pillars {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 1.5rem;
      margin-bottom: 4rem;
    }

    .pillar-card {
      background: rgba(13, 18, 28, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 2rem 1.75rem;
      backdrop-filter: blur(10px);
      transition: all 0.3s ease;
      position: relative;
    }

    .pillar-card:hover {
      border-color: var(--accent-neon);
      transform: translateY(-4px);
      box-shadow: 0 12px 30px -10px var(--accent-glow);
    }

    .pillar-icon {
      font-size: 1.75rem;
      margin-bottom: 1.25rem;
      display: inline-block;
    }

    .pillar-title {
      font-family: var(--display);
      font-size: 1.35rem;
      font-weight: 700;
      color: #fff;
      text-transform: uppercase;
      font-style: italic;
      margin-bottom: 0.75rem;
    }

    .pillar-text {
      color: var(--text-muted);
      font-size: 0.95rem;
      line-height: 1.6;
    }

    /* Terminal / Git CTA Box */
    .cta-box {
      background: #090d15;
      border: 1px solid rgba(0, 240, 255, 0.35);
      border-radius: 16px;
      padding: 2.5rem 2rem;
      max-width: 820px;
      width: 100%;
      margin: 0 auto 3rem;
      box-shadow: 0 0 50px -15px rgba(0, 240, 255, 0.2);
    }

    .cta-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .cta-title {
      font-family: var(--display);
      font-size: 1.4rem;
      font-weight: 700;
      font-style: italic;
      color: #fff;
      text-transform: uppercase;
    }

    .cta-sub {
      color: var(--text-muted);
      font-size: 0.95rem;
      margin-bottom: 1.5rem;
      line-height: 1.5;
    }

    .code-terminal {
      background: #040609;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      padding: 1rem 1.25rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--mono);
      font-size: 0.9rem;
      color: var(--accent-volt);
      margin-bottom: 1.5rem;
      overflow-x: auto;
    }

    .code-terminal span.cmd {
      color: #fff;
    }

    .copy-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      padding: 0.45rem 0.85rem;
      border-radius: 6px;
      font-family: var(--mono);
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
      margin-left: 1rem;
    }

    .copy-btn:hover {
      background: var(--accent-neon);
      color: #000;
      border-color: var(--accent-neon);
    }

    .action-links {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      justify-content: center;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.85rem 1.75rem;
      border-radius: 10px;
      font-family: var(--display);
      font-weight: 700;
      font-size: 1rem;
      text-transform: uppercase;
      font-style: italic;
      letter-spacing: 0.05em;
      text-decoration: none;
      transition: all 0.25s ease;
    }

    .btn-primary {
      background: var(--accent-neon);
      color: #000;
      box-shadow: 0 0 25px var(--accent-glow);
    }

    .btn-primary:hover {
      background: #fff;
      transform: translateY(-2px);
      box-shadow: 0 0 35px rgba(255, 255, 255, 0.5);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: #fff;
    }

    /* Footer */
    footer {
      margin-top: auto;
      text-align: center;
      padding-top: 2rem;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      font-family: var(--mono);
      font-size: 0.8rem;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }

    footer a {
      color: var(--accent-neon);
      text-decoration: none;
    }

    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <!-- Animated velocity line canvas in background -->
  <canvas class="motion-canvas" id="canvas"></canvas>

  <div class="wrapper">
    <!-- Top HUD telemetry bar -->
    <header class="hud-bar">
      <div class="hud-brand">
        <div class="hud-status-dot"></div>
        <div class="hud-logo">RIDRS<span>//</span>APP</div>
      </div>
      <div class="hud-telemetry">
        <div class="telemetry-item">
          <span class="telemetry-label">POWER:</span>
          <span class="telemetry-value" id="hud-power">340W</span>
        </div>
        <div class="telemetry-item">
          <span class="telemetry-label">CADENCE:</span>
          <span class="telemetry-value" id="hud-cadence">92 RPM</span>
        </div>
        <div class="telemetry-item">
          <span class="telemetry-label">PROTOCOL:</span>
          <span class="telemetry-value">BLE FTMS / ANT+</span>
        </div>
        <div class="telemetry-item">
          <span class="telemetry-label">STATUS:</span>
          <span class="telemetry-value" style="color: var(--accent-volt)">BUILDING</span>
        </div>
      </div>
    </header>

    <!-- Main Hero -->
    <main class="hero">
      <div class="tag-badge">
        <span>⚡</span> The Open Protocol For Cycling
      </div>

      <h1 class="hero-title">
        <span class="gradient-text">BREAK OUT OF</span><br>
        <span class="stroke-text">THE WALLED GARDENS.</span>
      </h1>

      <p class="hero-description">
        Stay tuned for <strong>RIDRS</strong>: the ultimate open-source, fully extendable, and crowd-coded cycling & indoor cycling platform. Engineered for real riders, modders, and developers who refuse subscription lock-ins.
      </p>

      <!-- Live Telemetry Display -->
      <div class="dial-console">
        <div class="dial-card">
          <div class="dial-metric">Trainer Power Output</div>
          <div class="dial-number"><span id="metric-power">342</span><span class="dial-unit">WATTS</span></div>
        </div>
        <div class="dial-card">
          <div class="dial-metric">Virtual Velocity</div>
          <div class="dial-number"><span id="metric-speed">43.8</span><span class="dial-unit">KM/H</span></div>
        </div>
        <div class="dial-card">
          <div class="dial-metric">Pedal Cadence</div>
          <div class="dial-number"><span id="metric-cadence">91</span><span class="dial-unit">RPM</span></div>
        </div>
      </div>

      <!-- Pillars Section -->
      <div class="features-heading">// PLATFORM ARCHITECTURE //</div>
      <div class="grid-pillars">
        <div class="pillar-card">
          <div class="pillar-icon">🔓</div>
          <h3 class="pillar-title">100% Open & Free</h3>
          <p class="pillar-text">No subscription traps or proprietary limits. Transparent code, libre physics engines, and open hardware driver support.</p>
        </div>
        <div class="pillar-card">
          <div class="pillar-icon">🛠️</div>
          <h3 class="pillar-title">Crowd-Coded</h3>
          <p class="pillar-text">Built in the open by cyclists and engineers worldwide. Build workouts, hack telemetry, or script custom race modes.</p>
        </div>
        <div class="pillar-card">
          <div class="pillar-icon">🧩</div>
          <h3 class="pillar-title">Limitless Plugins</h3>
          <p class="pillar-text">First-class extensibility. Hook into custom BLE/ANT+ smart trainers, steerers, heart rate sensors, and heads-up displays.</p>
        </div>
        <div class="pillar-card">
          <div class="pillar-icon">🌐</div>
          <h3 class="pillar-title">Virtual Worlds</h3>
          <p class="pillar-text">Render routes with WebGL/WebGPU. Import GPX tracks, generate procedural terrain, or build real-world replicas.</p>
        </div>
      </div>

      <!-- Terminal / GitHub CTA -->
      <div class="cta-box">
        <div class="cta-header">
          <div class="cta-title">Join The Build on GitHub</div>
          <span style="font-family: var(--mono); color: var(--accent-neon); font-size: 0.8rem;">[v0.1.0-alpha]</span>
        </div>
        <p class="cta-sub">
          We are laying the foundation right now. Star the repository, inspect the architecture, or jump into the code.
        </p>
        <div class="code-terminal">
          <div><span style="color: #64748b;">$</span> <span class="cmd">git clone https://github.com/ridrs/ridrs.app.git</span></div>
          <button class="copy-btn" id="copy-btn" onclick="copyGitCmd()">Copy</button>
        </div>
        <div class="action-links">
          <a href="https://github.com/ridrs/ridrs.app" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
            <span>⭐ Star On GitHub</span>
          </a>
          <a href="https://github.com/ridrs/ridrs.app/issues" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">
            <span>💬 Contribute Ideas</span>
          </a>
        </div>
      </div>
    </main>

    <!-- Footer -->
    <footer>
      <div>RIDRS &copy; 2026 // The Open-Source Cycling Movement</div>
      <div>
        <a href="https://github.com/ridrs/ridrs.app" target="_blank" rel="noopener">github.com/ridrs/ridrs.app</a>
      </div>
    </footer>
  </div>

  <script>
    // Copy command helper
    function copyGitCmd() {
      const cmd = "git clone https://github.com/ridrs/ridrs.app.git";
      navigator.clipboard.writeText(cmd).then(() => {
        const btn = document.getElementById("copy-btn");
        btn.innerText = "Copied!";
        btn.style.background = "#00f0ff";
        btn.style.color = "#000";
        setTimeout(() => {
          btn.innerText = "Copy";
          btn.style.background = "rgba(255, 255, 255, 0.08)";
          btn.style.color = "#fff";
        }, 2000);
      });
    }

    // Telemetry live simulator
    let power = 330;
    let cadence = 90;
    let speed = 42.5;

    setInterval(() => {
      power += Math.floor((Math.random() - 0.48) * 12);
      if (power < 280) power = 285;
      if (power > 460) power = 450;

      cadence += Math.floor((Math.random() - 0.49) * 4);
      if (cadence < 82) cadence = 84;
      if (cadence > 102) cadence = 100;

      speed = (35 + (power / 380) * 9.5).toFixed(1);

      document.getElementById('metric-power').innerText = power;
      document.getElementById('hud-power').innerText = power + 'W';
      document.getElementById('metric-cadence').innerText = cadence;
      document.getElementById('hud-cadence').innerText = cadence + ' RPM';
      document.getElementById('metric-speed').innerText = speed;
    }, 1800);

    // Canvas background animation: warp / kinetic speed lines
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    let width, height;
    let particles = [];

    function resize() {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    class Particle {
      constructor() {
        this.reset();
      }
      reset() {
        this.x = Math.random() * width;
        this.y = Math.random() * height;
        this.length = Math.random() * 80 + 20;
        this.speed = Math.random() * 3 + 1.5;
        this.opacity = Math.random() * 0.4 + 0.1;
      }
      update() {
        this.x -= this.speed * 2.5;
        this.y += this.speed * 0.8;
        if (this.x < -this.length || this.y > height + this.length) {
          this.x = width + Math.random() * 100;
          this.y = Math.random() * height * 0.8;
        }
      }
      draw() {
        ctx.beginPath();
        ctx.strokeStyle = "rgba(0, 240, 255, " + this.opacity + ")";
        ctx.lineWidth = 1;
        ctx.moveTo(this.x, this.y);
        ctx.lineTo(this.x + this.length, this.y - this.length * 0.35);
        ctx.stroke();
      }
    }

    for (let i = 0; i < 45; i++) {
      particles.push(new Particle());
    }

    function animate() {
      ctx.clearRect(0, 0, width, height);
      particles.forEach(p => {
        p.update();
        p.draw();
      });
      requestAnimationFrame(animate);
    }
    animate();
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: {
        "content-type": "text/html;charset=UTF-8",
        "cache-control": "no-cache",
      },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env));
  },
};
