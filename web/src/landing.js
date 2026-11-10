// The landing page at ridrs.app. Colours, type and components follow the native app
// (packages/ui-shell and the ui-* plugins); the logo and screenshots live in ../public.
export const landingPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ridrs: open-source indoor cycling</title>
  <meta name="description" content="ridrs is an open-source indoor cycling app. It connects to smart trainers, power meters and heart-rate straps over Bluetooth, and everything in it is a plugin.">
  <meta name="theme-color" content="#07090e">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://ridrs.app/">
  <meta property="og:title" content="ridrs: open-source indoor cycling">
  <meta property="og:description" content="Smart trainers, power meters and heart-rate straps over Bluetooth. Every part is a plugin you can read and change.">
  <meta property="og:image" content="https://ridrs.app/og.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="742">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <script>document.documentElement.classList.add('js');</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:ital,wght@1,600;1,700&family=JetBrains+Mono:wght@500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #07090e;
      --surface: #0d121c;
      --surface-raised: #131b2a;
      --border: #1b2a3c;
      --cyan: #00f0ff;
      --lime: #ccff00;
      --amber: #e8a838;
      --text: #f1f5f9;
      --muted: #8b9bb4;
      --faint: #5b6b82;
      --focus: #5aa9e6;
      --sans: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      --display: 'Chakra Petch', 'Plus Jakarta Sans', sans-serif;
      --mono: 'JetBrains Mono', ui-monospace, monospace;
      --gutter: clamp(1rem, 4vw, 2.5rem);
      --measure: 34rem;
    }

    *, *::before, *::after { box-sizing: border-box; }
    * { margin: 0; }

    html { -webkit-text-size-adjust: 100%; }

    body {
      background:
        radial-gradient(70rem 32rem at 75% -12rem, rgba(0, 240, 255, 0.09), transparent 70%),
        var(--bg);
      color: var(--text);
      font: 400 1rem/1.6 var(--sans);
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }

    [hidden] { display: none !important; }
    img { display: block; max-width: 100%; height: auto; }
    a { color: inherit; }
    ::selection { background: var(--cyan); color: var(--bg); }

    :focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 3px;
      border-radius: 6px;
    }

    .skip {
      position: absolute;
      left: var(--gutter);
      top: -4rem;
      padding: 0.5rem 1rem;
      background: var(--cyan);
      color: var(--bg);
      font-weight: 600;
      border-radius: 8px;
      text-decoration: none;
      z-index: 10;
    }
    .skip:focus { top: 1rem; }

    .container {
      width: 100%;
      max-width: 72rem;
      margin-inline: auto;
      padding-inline: var(--gutter);
    }

    /* Type, as in the app: italic display caps, mono eyebrows */
    .eyebrow {
      font: 600 0.75rem/1 var(--mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--cyan);
    }

    .page-title {
      font: italic 700 clamp(2.6rem, 7.5vw, 5.25rem)/0.98 var(--display);
      text-transform: uppercase;
      letter-spacing: -0.005em;
      text-wrap: balance;
    }
    .page-title .outline {
      color: transparent;
      -webkit-text-stroke: 1.3px var(--text);
      font-weight: 600;
    }

    .section-title {
      font: italic 700 clamp(1.5rem, 3.2vw, 2.1rem)/1.1 var(--display);
      text-transform: uppercase;
      text-wrap: balance;
    }

    .lede {
      color: var(--muted);
      font-size: clamp(1.05rem, 1.6vw, 1.2rem);
      max-width: var(--measure);
      text-wrap: pretty;
    }
    .lede strong { color: var(--text); font-weight: 600; }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      min-height: 3rem;
      padding: 0 1.5rem;
      border-radius: 999px;
      border: 1px solid transparent;
      font: 700 1rem/1 var(--sans);
      text-decoration: none;
      cursor: pointer;
      transition: background-color 0.15s, border-color 0.15s, color 0.15s;
    }
    .btn svg { width: 1.1em; height: 1.1em; flex: none; }
    .btn-primary { background: var(--lime); color: var(--bg); }
    .btn-secondary { background: var(--surface-raised); border-color: var(--border); color: var(--text); }

    @media (hover: hover) {
      .btn-primary:hover { background: #dbff4d; }
      .btn-secondary:hover { border-color: var(--cyan); }
    }

    /* Header */
    .site-header .container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding-block: 1.5rem;
    }
    .site-header .logo img { height: 1.6rem; width: auto; }

    .site-nav { display: flex; align-items: center; gap: 0.25rem; }
    .site-nav a {
      font-weight: 500;
      font-size: 0.95rem;
      text-decoration: none;
      color: var(--muted);
      padding: 0.5rem 0.85rem;
      border-radius: 12px;
      transition: color 0.15s, background-color 0.15s;
    }
    @media (hover: hover) {
      .site-nav a:hover { color: var(--text); background: rgba(255, 255, 255, 0.06); }
    }
    .site-nav .gh { color: var(--text); display: inline-flex; align-items: center; gap: 0.4rem; }
    .site-nav .gh svg { width: 1.1rem; height: 1.1rem; }

    @media (max-width: 40rem) {
      .site-nav .optional { display: none; }
    }

    /* Hero */
    .hero { padding-block: clamp(2.5rem, 8vw, 5.5rem) clamp(2.5rem, 6vw, 4rem); }
    .hero .eyebrow { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin-bottom: 1.75rem; }
    .hero .eyebrow span + span { color: var(--faint); }
    .hero .page-title { margin-bottom: 1.75rem; }
    .hero .lede { margin-bottom: 2rem; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }

    /* Screens */
    .screens { padding-bottom: clamp(4rem, 9vw, 7rem); scroll-margin-top: 1rem; }

    .tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    @media (max-width: 30rem) {
      .tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.35rem; }
      .tab { padding: 0 0.25rem; font-size: 0.85rem; }
    }

    .tab {
      flex: none;
      min-height: 2.25rem;
      padding: 0 1rem;
      border-radius: 999px;
      border: 0;
      background: var(--surface-raised);
      color: var(--text);
      font: 600 0.9rem/1 var(--sans);
      cursor: pointer;
      transition: background-color 0.15s, color 0.15s;
    }
    .tab[aria-selected="true"] { background: var(--cyan); color: var(--bg); }
    @media (hover: hover) {
      .tab[aria-selected="false"]:hover { background: #1a2436; }
    }

    .frame {
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      background: var(--surface);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 2.5rem 5rem -2.5rem rgba(0, 0, 0, 0.8);
    }
    .frame img { width: 100%; aspect-ratio: 2400 / 1485; }

    /* The Ride screenshot's tiles answer the pointer as in the app (ui-area-ride, ui-preview):
       the picture zooms to 104 % and a glowing dot rides the elevation profile once. Sizes are
       in the app's pixels (1684 px wide when captured), scaled to the frame with cqw. */
    #ride-frame { position: relative; container-type: inline-size; }
    .spot { position: absolute; overflow: hidden; border-radius: 3.54% / 5.66%; }
    .spot-zoom {
      position: absolute;
      inset: 0;
      background-repeat: no-repeat;
      opacity: 0;
      transition: transform 0.4s ease, opacity 0s linear 0.4s;
      -webkit-mask-image: linear-gradient(to bottom, transparent 15%, #000 24%, #000 46%, transparent 62%);
      mask-image: linear-gradient(to bottom, transparent 15%, #000 24%, #000 46%, transparent 62%);
    }
    .spot:hover .spot-zoom { opacity: 1; transform: scale(1.04); transition: transform 0.4s ease; }
    .spot-dot {
      position: absolute;
      width: max(4px, calc(7 / 1684 * 100cqw));
      aspect-ratio: 1;
      translate: -50% -50%;
      border-radius: 50%;
      background: #fff;
      box-shadow:
        0 0 calc(6 / 1684 * 100cqw) calc(2 / 1684 * 100cqw) var(--lime),
        0 0 calc(16 / 1684 * 100cqw) calc(5 / 1684 * 100cqw) rgba(204, 255, 0, 0.55);
      opacity: 0;
      pointer-events: none;
      will-change: opacity, left, top;
    }

    .panel + .panel { margin-top: 2.5rem; }
    .js .panel + .panel { margin-top: 0; }
    .js .panel[hidden] { display: none; }

    .caption {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: start;
      gap: 0.5rem 2rem;
      padding-top: 1.25rem;
    }
    .caption h3 {
      font: italic 700 1.25rem/1.2 var(--display);
      text-transform: uppercase;
      margin-bottom: 0.35rem;
    }
    .caption p { color: var(--muted); max-width: 38rem; text-wrap: pretty; }

    .pager { display: none; align-items: center; gap: 0.5rem; }
    .js .pager { display: flex; }
    .pager .count {
      font: 500 0.8rem/1 var(--mono);
      color: var(--faint);
      font-variant-numeric: tabular-nums;
      margin-right: 0.5rem;
    }
    .pager button {
      width: 2.5rem;
      height: 2.5rem;
      display: grid;
      place-items: center;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: var(--surface-raised);
      color: var(--text);
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .pager button svg { width: 1.1rem; height: 1.1rem; }
    @media (hover: hover) {
      .pager button:hover { border-color: var(--cyan); }
    }

    .credit {
      margin-top: 1.5rem;
      font-size: 0.8rem;
      color: var(--faint);
    }
    .credit a { color: var(--muted); }

    @media (max-width: 40rem) {
      .caption { grid-template-columns: 1fr; }
      .pager { order: -1; }
    }

    /* Features */
    .section { padding-block: clamp(4rem, 9vw, 7rem); border-top: 1px solid var(--border); }
    .section-head { display: grid; gap: 1rem; margin-bottom: clamp(2rem, 5vw, 3.5rem); }

    .features {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      list-style: none;
      padding: 0;
    }
    .features li {
      background: var(--bg);
      padding: 1.75rem 1.5rem 2rem;
    }
    .features h3 {
      font: italic 700 1.1rem/1.25 var(--display);
      text-transform: uppercase;
      margin-bottom: 0.6rem;
    }
    .features p { color: var(--muted); font-size: 0.95rem; text-wrap: pretty; }
    .features .icon { width: 1.5rem; height: 1.5rem; color: var(--cyan); margin-bottom: 1.25rem; }

    /* On the workbench: hints at experiments that are not in the app yet */
    .bench {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
      gap: 1.25rem;
    }
    .bench article {
      background:
        radial-gradient(120% 140% at 85% 0%, rgba(0, 240, 255, 0.1) 0%, transparent 60%),
        linear-gradient(160deg, var(--surface-raised), var(--surface));
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.25rem 1.25rem 1.5rem;
    }
    .bench .art {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #05070b;
      margin-bottom: 1.5rem;
    }
    .bench .art { aspect-ratio: 320 / 150; overflow: hidden; touch-action: pan-y; }
    .bench .art canvas { display: block; width: 100%; height: 100%; }
    .bench header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .bench h3 {
      font: italic 700 1.35rem/1.15 var(--display);
      text-transform: uppercase;
    }
    .chip {
      flex: none;
      font: 600 0.65rem/1 var(--mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--cyan);
      border: 1px solid var(--amber);
      border-radius: 999px;
      padding: 0.3rem 0.6rem;
    }

    /* How it is built */
    .facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
      gap: 2rem 3rem;
    }
    .facts dt { margin-bottom: 0.6rem; }
    .facts dd { color: var(--muted); font-size: 0.95rem; text-wrap: pretty; }
    .facts code { font-family: var(--mono); font-size: 0.85em; color: var(--text); white-space: nowrap; }

    /* Build it */
    .build {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
      gap: 2rem 4rem;
      align-items: start;
    }
    @media (max-width: 56rem) {
      .build { grid-template-columns: minmax(0, 1fr); }
    }
    .build .section-title { margin-top: 1rem; }
    .build .lede { margin-top: 1rem; }
    .build .actions { margin-top: 2rem; }
    .build .note { margin-top: 1rem; color: var(--faint); font-size: 0.9rem; max-width: var(--measure); }

    .terminal {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: #04060a;
      overflow: hidden;
    }
    .terminal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.6rem 0.6rem 0.6rem 1.1rem;
      border-bottom: 1px solid var(--border);
      font: 500 0.75rem/1 var(--mono);
      color: var(--faint);
    }
    .copy {
      min-height: 2rem;
      padding: 0 0.85rem;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-raised);
      color: var(--text);
      font: 600 0.75rem/1 var(--mono);
      cursor: pointer;
    }
    .copy[data-done] { background: var(--cyan); border-color: var(--cyan); color: var(--bg); }
    .terminal pre {
      margin: 0;
      padding: 1.1rem 1.25rem 1.25rem;
      overflow-x: auto;
      font: 500 0.875rem/1.9 var(--mono);
      color: var(--text);
    }
    .terminal pre .c { color: var(--faint); }
    .terminal pre .p { color: var(--faint); user-select: none; }

    /* Footer */
    .site-footer { border-top: 1px solid var(--border); }
    .site-footer .container {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1rem 2rem;
      padding-block: 2rem 2.5rem;
      font-size: 0.85rem;
      color: var(--faint);
    }
    .site-footer .mark { display: flex; align-items: center; gap: 0.75rem; }
    .site-footer .mark img { height: 0.9rem; width: auto; }
    .site-footer nav { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; }
    .site-footer a { color: var(--muted); text-decoration: none; }
    @media (hover: hover) {
      .site-footer a:hover { color: var(--text); }
    }

    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>

  <header class="site-header">
    <div class="container">
      <a class="logo" href="/"><img src="/logo.svg" width="1774" height="335" alt="ridrs"></a>
      <nav class="site-nav" aria-label="Main">
        <a class="optional" href="#screens">Screens</a>
        <a class="optional" href="#features">Features</a>
        <a class="optional" href="#build">Build it</a>
        <a class="gh" href="https://github.com/ridrs/ridrs.app">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>
          GitHub
        </a>
      </nav>
    </div>
  </header>

  <main id="main">
    <section class="hero">
      <div class="container">
        <p class="eyebrow"><span>Open source</span><span>v0.1.0</span><span>In development</span></p>
        <h1 class="page-title">Indoor cycling<br><span class="outline">without the lock-in</span></h1>
        <p class="lede">
          <strong>ridrs</strong> is an indoor cycling platform built in the open. Trainer drivers, physics, video worlds and every screen are plugins you can read, fork and replace. It's early, and we're looking for people who want to build it with us.
        </p>
        <div class="actions">
          <a class="btn btn-primary" href="#screens">See the app</a>
          <a class="btn btn-secondary" href="https://github.com/ridrs/ridrs.app">Read the source</a>
        </div>
      </div>
    </section>

    <section class="screens" id="screens" aria-label="Screens">
      <div class="container">
        <div class="tabs" role="tablist" aria-label="Screens" hidden>
          <button class="tab" role="tab" type="button" id="tab-today" aria-controls="panel-today" aria-selected="true">Today</button>
          <button class="tab" role="tab" type="button" id="tab-ride" aria-controls="panel-ride" aria-selected="false" tabindex="-1">Ride</button>
          <button class="tab" role="tab" type="button" id="tab-training" aria-controls="panel-training" aria-selected="false" tabindex="-1">Training</button>
          <button class="tab" role="tab" type="button" id="tab-devices" aria-controls="panel-devices" aria-selected="false" tabindex="-1">Devices</button>
        </div>

        <div class="panel" id="panel-today" role="tabpanel" aria-labelledby="tab-today">
          <div class="frame">
            <img src="/screens/today.webp" srcset="/screens/today.webp 1200w, /screens/today@2x.webp 2400w" sizes="(min-width: 72rem) 67rem, 100vw" width="2400" height="1485" fetchpriority="high" alt="The Today screen. A large Start ride button, a list of devices that are searching, a Ride again card for a video route in the Vercors, and the next workout from an intervals.icu plan with its interval chart.">
          </div>
          <div class="caption">
            <div>
              <h3>Today</h3>
              <p>Start a free ride straight away. Devices connect in the background, next to the workout your plan has for today and a route to ride again.</p>
            </div>
          </div>
        </div>

        <div class="panel" id="panel-ride" role="tabpanel" aria-labelledby="tab-ride">
          <div class="frame" id="ride-frame">
            <img src="/screens/ride.webp" srcset="/screens/ride.webp 1200w, /screens/ride@2x.webp 2400w" sizes="(min-width: 72rem) 67rem, 100vw" width="2400" height="1485" loading="lazy" decoding="async" alt="The Ride screen. A grid of real video routes, each tile a picture of the route with its name, distance, climbing and elevation profile: Col de Pennes, the Gorges des Gâts, Col de Grimone, Lahntal and more.">
          </div>
          <div class="caption">
            <div>
              <h3>Ride</h3>
              <p>Filmed routes, each with its distance, climbing and elevation profile. Point at a tile to ride its profile.</p>
            </div>
          </div>
        </div>

        <div class="panel" id="panel-training" role="tabpanel" aria-labelledby="tab-training">
          <div class="frame">
            <img src="/screens/training.webp" srcset="/screens/training.webp 1200w, /screens/training@2x.webp 2400w" sizes="(min-width: 72rem) 67rem, 100vw" width="2400" height="1485" loading="lazy" decoding="async" alt="The Training screen. A rider on an indoor bike above a week calendar with planned workouts on Tuesday, Thursday and Sunday, and a finished one on Tuesday.">
          </div>
          <div class="caption">
            <div>
              <h3>Training</h3>
              <p>The week at the centre. Drag a workout onto a day to plan it, or drag a planned one to another day to move it.</p>
            </div>
          </div>
        </div>

        <div class="panel" id="panel-devices" role="tabpanel" aria-labelledby="tab-devices">
          <div class="frame">
            <img src="/screens/devices.webp" srcset="/screens/devices.webp 1200w, /screens/devices@2x.webp 2400w" sizes="(min-width: 72rem) 67rem, 100vw" width="2400" height="1485" loading="lazy" decoding="async" alt="The Connect your devices dialog. Power meter, smart trainer and heart rate monitor are searching; the companion app on a phone is not reachable.">
          </div>
          <div class="caption">
            <div>
              <h3>Devices</h3>
              <p>Power meter, smart trainer, heart-rate monitor and the phone companion each show their own state. You can start riding before all of them are found.</p>
            </div>
          </div>
        </div>

        <p class="credit">Captured from the macOS build in November 2026. Video routes and profiles by Fred Van Gestel, <a href="https://cycling.vangestel.online/indoor/videos/">cycling.vangestel.online</a>, <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>; the route pictures are AI-generated from his originals, under the same licence. Training photo by Munbaik Cycling Clothing on Unsplash.</p>
      </div>
    </section>

    <section class="section" id="features" aria-labelledby="features-title">
      <div class="container">
        <div class="section-head">
          <p class="eyebrow">What works today</p>
          <h2 class="section-title" id="features-title">Ride, train, export</h2>
        </div>
        <ul class="features">
          <li>
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            <h3>Trainers and sensors</h3>
            <p>FTMS smart trainers, power meters and heart-rate straps over Bluetooth. The Zwift Ride controller works too.</p>
          </li>
          <li>
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="12" height="20" x="6" y="2" rx="2"/><path d="M12 18h.01"/></svg>
            <h3>Your phone as a bridge</h3>
            <p>The companion app forwards a phone's Bluetooth to ridrs over the local network, for when the computer's own radio can't reach the trainer.</p>
          </li>
          <li>
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            <h3>ERG and virtual gears</h3>
            <p>Hold a target power in ERG mode, or shift through virtual gears while the trainer simulates the road.</p>
          </li>
          <li>
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 8-6 4 6 4V8z"/><rect width="14" height="12" x="2" y="6" rx="2"/></svg>
            <h3>Real video routes</h3>
            <p>Ride filmed routes from the Van Gestel catalogue, or bring the videos you already have in Incyclist.</p>
          </li>
          <li>
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            <h3>Plan and export</h3>
            <p>Your planned workouts come in from intervals.icu, and every ride is saved as a FIT file you own.</p>
          </li>
          <li>
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="5" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 13h6"/></svg>
            <h3>Keyboard and remote</h3>
            <p>Every screen works with the arrow keys, Enter and Back alone, so the app runs from the saddle with a remote.</p>
          </li>
        </ul>
      </div>
    </section>

    <section class="section" id="lab" aria-labelledby="lab-title">
      <div class="container">
        <div class="section-head">
          <p class="eyebrow">On the workbench</p>
          <h2 class="section-title" id="lab-title">Not in the app. Yet.</h2>
          <p class="lede">Going where no rider has gone before.</p>
        </div>
        <div class="bench">
          <article aria-labelledby="lab-line">
            <div class="art" data-art="line"><canvas aria-hidden="true"></canvas></div>
            <header>
              <h3 id="lab-line">Choose the line</h3>
              <span class="chip">Research</span>
            </header>
          </article>

          <article aria-labelledby="lab-tabata">
            <div class="art" data-art="beat"><canvas aria-hidden="true"></canvas></div>
            <header>
              <h3 id="lab-tabata">Ride the drop</h3>
              <span class="chip">Prototype</span>
            </header>
          </article>

          <article aria-labelledby="lab-frame">
            <div class="art" data-art="gpx"><canvas aria-hidden="true"></canvas></div>
            <header>
              <h3 id="lab-frame">Reading the road</h3>
              <span class="chip">Research</span>
            </header>
          </article>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="built-title">
      <div class="container">
        <div class="section-head">
          <p class="eyebrow">How it is built</p>
          <h2 class="section-title" id="built-title">Small parts, open contracts</h2>
        </div>
        <dl class="facts">
          <div>
            <dt class="eyebrow">Everywhere</dt>
            <dd>One codebase for macOS, Windows, Android and iOS on Tauri 2, plus a headless mode for the terminal.</dd>
          </div>
          <div>
            <dt class="eyebrow">Plugins</dt>
            <dd>Devices, physics, screens and widgets are all plugins. They talk only through public events and capabilities, never to each other directly.</dd>
          </div>
          <div>
            <dt class="eyebrow">Physics</dt>
            <dd>Virtual speed comes from separate models for gravity, rolling resistance, aerodynamics and the drivetrain. Read them, swap them.</dd>
          </div>
          <div>
            <dt class="eyebrow">Replay</dt>
            <dd>The simulation is deterministic: the same recorded inputs give the same ride, every time.</dd>
          </div>
          <div>
            <dt class="eyebrow">Licences</dt>
            <dd>Core and plugins under <code>AGPL-3.0-or-later</code>. The plugin SDK and contracts under <code>Apache-2.0</code>.</dd>
          </div>
        </dl>
      </div>
    </section>

    <section class="section" id="build" aria-labelledby="build-title">
      <div class="container build">
        <div>
          <p class="eyebrow">No release yet</p>
          <h2 class="section-title" id="build-title">Build it from source</h2>
          <p class="lede">There is no download yet. If you have a trainer and a free evening, run the app from the repository and tell us what breaks.</p>
          <p class="note">Needs Node.js, pnpm and Rust. No trainer? The test suite rides with a simulated one.</p>
          <div class="actions">
            <a class="btn btn-secondary" href="https://github.com/ridrs/ridrs.app/issues">Open an issue</a>
          </div>
        </div>
        <div class="terminal">
          <div class="terminal-head">
            <span>Terminal</span>
            <button class="copy" type="button" id="copy" hidden>Copy</button>
          </div>
<pre id="commands"><span class="p">$ </span>git clone https://github.com/ridrs/ridrs.app.git
<span class="p">$ </span>cd ridrs.app
<span class="p">$ </span>pnpm install
<span class="c"># the desktop app, with hot reload</span>
<span class="p">$ </span>pnpm --filter @ridrs/native tauri dev</pre>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">
      <div class="mark"><img src="/favicon.svg" width="463" height="265" alt="">ridrs 0.1.0 &middot; AGPL-3.0-or-later</div>
      <nav aria-label="Footer">
        <a href="https://github.com/ridrs/ridrs.app">Source</a>
        <a href="https://github.com/ridrs/ridrs.app/issues">Issues</a>
        <a href="https://github.com/ridrs/ridrs.app/blob/main/LICENSING.md">Licensing</a>
      </nav>
    </div>
  </footer>

  <script>
    // Screens: tabs with arrow keys, Home and End; prev/next in each caption.
    (function () {
      var tablist = document.querySelector('.tabs');
      var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
      var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });
      var arrow = function (d) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
      };

      tablist.hidden = false;
      panels.forEach(function (panel, i) {
        panel.tabIndex = 0;
        var pager = document.createElement('div');
        pager.className = 'pager';
        pager.innerHTML =
          '<span class="count">0' + (i + 1) + ' / 0' + panels.length + '</span>' +
          '<button type="button" aria-label="Previous screen">' + arrow('m15 18-6-6 6-6') + '</button>' +
          '<button type="button" aria-label="Next screen">' + arrow('m9 18 6-6-6-6') + '</button>';
        pager.children[1].addEventListener('click', function () { select(i - 1, false); });
        pager.children[2].addEventListener('click', function () { select(i + 1, false); });
        panel.querySelector('.caption').appendChild(pager);
      });

      function select(i, focusTab) {
        i = (i + tabs.length) % tabs.length;
        tabs.forEach(function (tab, n) {
          var on = n === i;
          tab.setAttribute('aria-selected', on ? 'true' : 'false');
          tab.tabIndex = on ? 0 : -1;
          panels[n].hidden = !on;
        });
        if (focusTab) tabs[i].focus();
      }

      tabs.forEach(function (tab, i) {
        tab.addEventListener('click', function () { select(i, false); });
        tab.addEventListener('keydown', function (e) {
          var to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
          if (to === undefined) return;
          e.preventDefault();
          select(to, true);
        });
      });

      select(0, false);

      // Hidden panels never enter the viewport, so lazy loading alone would show an empty
      // frame on first switch; fetch them once the page itself has loaded.
      window.addEventListener('load', function () {
        panels.forEach(function (panel) { panel.querySelector('img').loading = 'eager'; });
      });
    })();

    // Ride tiles: measured in the running app as [left, top, width, height] in percent of the
    // screenshot, plus the profile line in percent of the tile. Only fully visible tiles.
    (function () {
      var frame = document.getElementById('ride-frame');
      var img = frame.querySelector('img');
      var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var tiles = [
        [14.25,23.9,20.13,20.33,'0.0,95.7 2.2,95.5 4.4,93.7 6.6,91.5 8.8,89.2 11.0,87.5 13.2,85.5 15.4,83.2 17.5,80.6 19.7,78.2 21.9,75.6 24.1,74.0 26.3,76.2 28.5,79.3 30.7,82.3 32.9,85.4 35.1,89.0 37.3,92.9 39.4,96.7 41.6,95.9 43.8,94.3 46.0,92.7 48.2,91.5 50.4,90.2 52.6,88.7 54.8,86.1 57.0,85.9 59.2,86.2 61.4,84.7 63.5,82.5 65.7,79.7 67.9,77.2 70.1,74.2 72.3,74.6 74.5,76.6 76.7,78.9 78.9,81.2 81.1,84.1 83.3,86.8 85.4,89.5 87.6,91.3 89.8,92.6 92.1,93.9 94.2,94.5 96.4,94.3 98.6,93.9 100.0,94.1'],
        [35.15,23.9,20.13,20.33,'0.0,96.6 2.2,96.4 4.4,96.3 6.6,95.6 8.8,94.9 11.0,94.1 13.2,93.5 15.4,92.7 17.5,91.5 19.7,91.2 21.9,92.0 24.1,92.5 26.3,92.3 28.5,92.0 30.7,92.9 32.8,94.0 35.0,94.5 37.2,94.0 39.4,93.3 41.6,93.4 43.8,93.5 46.0,92.8 48.1,92.1 50.3,91.9 52.5,92.0 54.7,91.7 56.9,91.2 59.1,90.7 61.3,90.3 63.4,89.9 65.7,89.3 67.9,88.9 70.0,88.3 72.2,87.8 74.4,87.0 76.6,86.7 78.8,86.1 81.0,85.5 83.2,84.3 85.3,82.8 87.5,81.3 89.7,79.7 91.9,78.2 94.1,77.4 96.3,78.1 98.5,78.4 100.0,78.5'],
        [56.06,23.9,20.13,20.33,'0.0,96.7 2.2,96.4 4.4,96.2 6.6,95.9 8.7,95.7 10.9,95.3 13.1,94.8 15.3,94.3 17.5,93.8 19.7,93.2 21.9,92.8 24.1,92.3 26.3,91.8 28.5,91.3 30.7,90.8 32.8,90.3 35.0,89.7 37.2,89.2 39.4,88.7 41.6,88.2 43.8,87.6 46.0,87.0 48.2,86.4 50.4,86.3 52.6,85.9 54.7,85.3 56.9,84.8 59.2,84.4 61.4,83.9 63.5,83.5 65.7,83.0 67.9,82.5 70.1,82.0 72.3,81.5 74.5,81.0 76.7,80.5 78.8,79.9 81.1,79.4 83.3,78.9 85.4,78.4 87.6,78.1 89.8,77.9 92.0,77.7 94.2,77.6 96.4,77.4 98.6,77.2 100.0,77.1'],
        [76.96,23.9,20.13,20.33,'0.0,69.6 2.2,70.0 4.4,70.9 6.6,72.4 8.7,73.7 10.9,75.0 13.1,76.1 15.3,77.7 17.5,79.0 19.7,80.4 21.9,81.8 24.0,82.7 26.2,83.0 28.4,82.7 30.6,82.6 32.8,84.1 35.0,85.5 37.2,86.9 39.4,88.1 41.6,88.6 43.8,89.0 46.0,89.6 48.1,90.2 50.3,90.8 52.5,91.3 54.7,91.7 56.9,92.2 59.1,92.7 61.3,92.8 63.4,92.9 65.6,93.6 67.8,93.9 70.0,93.9 72.2,94.5 74.4,94.8 76.6,93.9 78.7,93.0 80.9,93.5 83.1,93.4 85.3,92.6 87.5,93.5 89.7,94.3 91.9,94.9 94.1,95.7 96.3,96.2 98.5,96.5 100.0,96.6'],
        [14.25,45.77,20.13,20.33,'0.0,96.6 2.2,96.6 4.4,96.4 6.6,95.7 8.7,95.2 10.9,96.2 13.1,96.7 15.3,96.6 17.5,94.3 19.7,94.0 21.9,95.8 24.1,95.6 26.3,94.5 28.5,93.2 30.7,90.9 32.8,87.8 35.0,86.2 37.2,87.5 39.4,88.3 41.6,89.5 43.8,90.0 46.0,90.0 48.1,88.9 50.3,87.9 52.5,87.0 54.7,85.2 56.9,83.6 59.1,84.4 61.3,85.6 63.4,87.4 65.6,89.1 67.8,90.8 70.0,91.9 72.2,91.6 74.4,90.1 76.6,88.9 78.7,90.9 81.0,92.4 83.2,93.5 85.3,94.9 87.5,95.6 89.7,95.8 91.9,95.9 94.1,95.9 96.3,96.2 98.5,96.6 100.0,96.6'],
        [35.15,45.77,20.13,20.33,'0.0,90.9 2.2,91.0 4.4,92.0 6.6,91.8 8.8,90.0 11.0,90.1 13.2,91.8 15.4,92.1 17.5,92.3 19.7,92.7 21.9,92.9 24.1,93.0 26.3,93.3 28.5,93.5 30.7,93.7 32.8,93.8 35.0,93.9 37.2,94.0 39.4,94.2 41.6,94.4 43.8,94.5 46.0,94.6 48.1,94.8 50.3,94.9 52.5,94.9 54.7,95.0 56.9,95.1 59.1,95.2 61.3,95.3 63.4,95.5 65.7,95.6 67.9,95.7 70.0,95.6 72.2,95.5 74.4,95.5 76.6,95.8 78.8,95.7 81.0,95.3 83.2,96.3 85.3,96.3 87.5,96.4 89.7,96.4 91.9,96.3 94.1,96.4 96.3,96.7 98.5,96.6 100.0,96.5'],
        [56.06,45.77,20.13,20.33,'0.0,95.8 2.2,96.2 4.4,96.4 6.6,96.6 8.7,96.6 10.9,96.7 13.1,96.7 15.3,96.4 17.5,96.0 19.7,95.5 21.9,94.8 24.1,94.3 26.3,93.9 28.5,93.0 30.7,92.3 32.8,92.0 35.0,91.0 37.2,89.9 39.4,88.6 41.6,87.3 43.8,85.9 46.0,84.6 48.2,83.4 50.4,82.1 52.6,80.8 54.7,79.6 56.9,78.9 59.2,79.9 61.4,81.0 63.5,82.0 65.7,82.9 67.9,83.9 70.1,84.8 72.3,85.4 74.5,86.3 76.7,87.0 78.8,87.7 81.1,88.5 83.3,89.7 85.4,90.5 87.6,91.0 89.8,92.1 92.0,93.3 94.2,94.1 96.4,94.5 98.6,95.3 100.0,95.8'],
        [76.96,45.77,20.13,20.33,'0.0,96.3 2.2,96.5 4.4,96.5 6.6,96.2 8.7,95.5 10.9,94.5 13.1,95.1 15.3,95.6 17.5,95.5 19.7,95.1 21.9,94.9 24.0,94.7 26.2,94.6 28.4,94.2 30.6,93.7 32.8,93.4 35.0,92.5 37.2,92.0 39.4,91.6 41.6,90.7 43.8,89.9 46.0,89.9 48.1,89.9 50.3,89.1 52.5,88.3 54.7,87.5 56.9,86.9 59.1,86.1 61.3,87.3 63.4,88.4 65.6,89.3 67.8,89.8 70.0,90.7 72.2,91.3 74.4,91.7 76.6,92.4 78.7,93.1 80.9,93.7 83.1,94.3 85.3,94.7 87.5,95.3 89.7,95.9 91.9,95.8 94.1,96.0 96.3,96.6 98.5,96.6 100.0,96.3'],
        [14.25,67.63,20.13,20.33,'0.0,96.7 2.2,96.7 4.4,96.5 6.6,96.4 8.8,96.2 11.0,96.4 13.2,96.3 15.4,96.3 17.5,96.2 19.7,95.2 21.9,95.8 24.1,95.7 26.3,95.5 28.5,95.6 30.7,95.5 32.9,95.4 35.1,95.4 37.3,95.2 39.4,95.1 41.6,94.9 43.8,94.8 46.0,94.7 48.2,94.7 50.4,94.5 52.6,94.4 54.8,94.2 57.0,94.2 59.2,94.1 61.4,94.0 63.5,93.8 65.7,93.7 67.9,93.6 70.1,93.7 72.3,93.3 74.5,93.2 76.7,92.9 78.9,92.8 81.1,92.6 83.3,91.9 85.4,92.1 87.6,91.7 89.8,89.3 92.1,90.8 94.2,91.7 96.4,91.7 98.6,91.0 100.0,91.0'],
        [35.15,67.63,20.13,20.33,'0.0,96.4 2.2,96.6 4.4,96.0 6.6,96.1 8.8,95.4 11.0,94.7 13.2,94.0 15.4,93.3 17.5,92.4 19.7,91.9 21.9,90.8 24.1,90.1 26.3,88.8 28.5,87.4 30.7,87.9 32.9,88.6 35.1,89.2 37.3,89.7 39.4,89.4 41.6,88.5 43.9,88.8 46.1,89.9 48.2,91.1 50.4,92.1 52.6,92.8 54.8,92.1 57.0,91.7 59.2,90.9 61.4,90.6 63.5,90.8 65.8,90.5 68.0,89.7 70.1,89.2 72.3,89.0 74.5,88.8 76.7,89.0 78.9,88.7 81.1,88.2 83.3,87.9 85.5,87.6 87.7,86.7 89.9,86.7 92.1,86.0 94.2,85.5 96.4,85.5 98.6,85.5 100.0,84.6'],
        [56.06,67.63,20.13,20.33,'0.0,96.8 2.2,96.3 4.4,95.6 6.6,94.8 8.7,93.8 10.9,93.1 13.1,92.1 15.3,91.2 17.5,90.5 19.7,89.6 21.9,88.7 24.1,87.9 26.3,87.1 28.5,86.2 30.7,85.4 32.8,84.3 35.0,83.3 37.2,82.5 39.4,81.7 41.6,80.7 43.8,79.8 46.0,78.6 48.2,77.5 50.4,76.6 52.6,75.6 54.7,74.7 56.9,73.8 59.2,72.7 61.4,71.9 63.5,70.9 65.7,71.8 67.9,72.7 70.1,73.7 72.3,74.6 74.5,75.5 76.7,76.4 78.8,77.3 81.1,78.3 83.3,79.4 85.4,80.3 87.6,81.2 89.8,81.9 92.0,82.7 94.2,83.7 96.4,84.8 98.6,85.6 100.0,86.1'],
        [76.96,67.63,20.13,20.33,'0.0,83.4 2.2,82.3 4.4,80.8 6.6,79.2 8.7,77.8 10.9,76.5 13.2,73.8 15.4,71.9 17.5,71.2 19.7,70.1 21.9,68.5 24.1,68.6 26.3,70.0 28.5,70.8 30.7,71.7 32.9,73.7 35.1,76.1 37.3,77.1 39.4,78.7 41.6,80.5 43.8,81.9 46.0,83.1 48.2,84.3 50.4,85.4 52.6,86.7 54.8,88.0 57.0,89.1 59.2,90.4 61.4,91.0 63.5,91.5 65.7,92.0 67.9,92.5 70.1,92.9 72.3,93.2 74.5,93.4 76.7,93.9 78.9,94.1 81.1,94.7 83.3,95.1 85.4,95.5 87.6,95.8 89.8,95.9 92.0,96.1 94.2,96.3 96.4,96.4 98.6,96.6 100.0,96.7']
      ];
      var zooms = [];

      tiles.forEach(function (t) {
        var x = t[0], y = t[1], w = t[2], h = t[3];
        var points = t[4].split(' ').map(function (p) { return p.split(',').map(Number); });
        var spot = document.createElement('div');
        spot.className = 'spot';
        spot.setAttribute('aria-hidden', 'true');
        spot.style.cssText = 'left:' + x + '%;top:' + y + '%;width:' + w + '%;height:' + h + '%';

        var zoom = document.createElement('div');
        zoom.className = 'spot-zoom';
        zoom.style.backgroundSize = (10000 / w) + '% ' + (10000 / h) + '%';
        zoom.style.backgroundPosition = (x / (100 - w) * 100) + '% ' + (y / (100 - h) * 100) + '%';
        zooms.push(zoom);

        var dot = document.createElement('span');
        dot.className = 'spot-dot';
        spot.appendChild(zoom);
        spot.appendChild(dot);
        frame.appendChild(spot);

        // As in the app: once from start to end on enter, gone at once on leave.
        var running = null;
        spot.addEventListener('mouseenter', function () {
          if (reduceMotion || !dot.animate || (running && running.playState === 'running')) return;
          running = dot.animate(points.map(function (p, i) {
            return { left: p[0] + '%', top: p[1] + '%', opacity: i === 0 || i === points.length - 1 ? 0 : 1 };
          }), { duration: 1600, easing: 'ease-in-out' });
        });
        spot.addEventListener('mouseleave', function () { if (running) running.cancel(); });
      });

      function useImage() {
        var src = img.currentSrc || img.src;
        zooms.forEach(function (z) { z.style.backgroundImage = 'url("' + src + '")'; });
      }
      img.addEventListener('load', useImage);
      if (img.complete) useImage();
    })();

    // Workbench art. Each scene draws itself into a canvas and shows a still frame until the
    // pointer is over it; it then animates on its own clock, and keeps going briefly after the
    // pointer leaves so it can settle. With reduced motion it stays a still frame, redrawn when
    // the pointer moves.
    var stillMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function scene(box, draw, settleMs) {
      var canvas = box.querySelector('canvas');
      var ctx = canvas.getContext('2d');
      var size = { w: 0, h: 0 };
      var clock = 4200;
      var hovered = false, settleUntil = 0, lastNow = 0;
      var frame = 0;
      function resize() {
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        size.w = canvas.clientWidth;
        size.h = canvas.clientHeight;
        canvas.width = Math.round(size.w * dpr);
        canvas.height = Math.round(size.h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      function running(now) { return !stillMotion && (hovered || now < settleUntil); }
      function tick(now) {
        frame = 0;
        if (!size.w) return;
        if (running(now) && lastNow) clock += Math.min(now - lastNow, 100);
        lastNow = running(now) ? now : 0;
        draw(ctx, size.w, size.h, clock);
        if (running(now)) frame = requestAnimationFrame(tick);
      }
      function kick() { if (!frame) frame = requestAnimationFrame(tick); }
      new ResizeObserver(function () { resize(); kick(); }).observe(canvas);
      box.addEventListener('pointerenter', function () { hovered = true; kick(); });
      box.addEventListener('pointerleave', function () {
        hovered = false;
        settleUntil = performance.now() + (settleMs || 0);
        kick();
      });
      return kick;
    }

    function mix(a, b, k) {
      return 'rgb(' + [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * k); }).join(',') + ')';
    }

    // Choose the line: a road in perspective, at 50 km/h. The pointer moves the camera across
    // the road (left/right) and up and down; the cyan line bends to where you steer, the dashed
    // one is where the video was filmed. No text in the picture.
    (function () {
      var box = document.querySelector('[data-art="line"]');
      var FILMED = 1.6;
      var cam = { x: FILMED, h: 1.1 };
      var target = { x: FILMED, h: 1.1 };
      var last = 0;
      var kick;

      function ridge(x, seed, w) {
        var u = x / w;
        return Math.sin(u * 7.1 + seed) * 0.5 + Math.sin(u * 13.7 + seed * 2.3) * 0.28 + Math.sin(u * 29.3 + seed * 0.7) * 0.12;
      }

      function draw(ctx, w, h, t) {
        var dt = last ? Math.min((t - last) / 1000, 0.1) : 0;
        last = t;
        var ease = stillMotion ? 1 : 1 - Math.exp(-dt * 3.5);
        cam.x += (target.x - cam.x) * ease;
        cam.h += (target.h - cam.h) * ease;

        var f = w * 0.85;
        var cx = w / 2 - cam.x * w * 0.035;
        var horizon = h * 0.44 + (cam.h - 1.1) * h * 0.06;
        var travelled = (t / 1000) * 13.9;
        function sx(x, z) { return cx + (f * (x - cam.x)) / z; }
        function sy(y, z) { return horizon + (f * (cam.h - y)) / z; }

        // Sky and haze
        ctx.fillStyle = '#05070b';
        ctx.fillRect(0, 0, w, h);
        var haze = ctx.createLinearGradient(0, horizon - h * 0.35, 0, horizon);
        haze.addColorStop(0, 'rgba(0,240,255,0)');
        haze.addColorStop(1, 'rgba(0,240,255,0.2)');
        ctx.fillStyle = haze;
        ctx.fillRect(0, 0, w, horizon);

        // Two mountain ridges, far and near, with a little parallax
        [[0.24, 0.012, 1.3, '#1a3047'], [0.14, 0.03, 4.1, '#10203a']].forEach(function (r) {
          var shift = -cam.x * w * r[1];
          ctx.beginPath();
          ctx.moveTo(0, horizon + 1);
          for (var x = 0; x <= w + 4; x += 4) {
            ctx.lineTo(x, horizon - h * r[0] * (0.55 + 0.45 * ridge(x - shift, r[2], w)));
          }
          ctx.lineTo(w, horizon + 1);
          ctx.closePath();
          ctx.fillStyle = r[3];
          ctx.fill();
        });

        // Ground and road
        var ground = ctx.createLinearGradient(0, horizon, 0, h);
        ground.addColorStop(0, '#13243a');
        ground.addColorStop(0.35, '#0b1522');
        ground.addColorStop(1, '#080e17');
        ctx.fillStyle = ground;
        ctx.fillRect(0, horizon, w, h - horizon);
        var near = 0.9, far = 600;
        ctx.beginPath();
        ctx.moveTo(sx(-3.2, near), sy(0, near));
        ctx.lineTo(sx(-3.2, far), sy(0, far));
        ctx.lineTo(sx(3.2, far), sy(0, far));
        ctx.lineTo(sx(3.2, near), sy(0, near));
        ctx.closePath();
        ctx.fillStyle = '#0c121c';
        ctx.fill();
        ctx.strokeStyle = '#3d4b60';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(sx(-3.2, near), sy(0, near)); ctx.lineTo(sx(-3.2, far), sy(0, far));
        ctx.moveTo(sx(3.2, near), sy(0, near)); ctx.lineTo(sx(3.2, far), sy(0, far));
        ctx.stroke();

        // Centre dashes, 3 m every 9 m, rolling towards the camera
        ctx.fillStyle = '#4a5970';
        for (var k = 0; k < 40; k++) {
          var z0 = k * 9 - (travelled % 9) + near;
          var z1 = z0 + 3;
          if (z1 <= near) continue;
          z0 = Math.max(z0, near);
          ctx.beginPath();
          ctx.moveTo(sx(-0.07, z0), sy(0, z0)); ctx.lineTo(sx(0.07, z0), sy(0, z0));
          ctx.lineTo(sx(0.07, z1), sy(0, z1)); ctx.lineTo(sx(-0.07, z1), sy(0, z1));
          ctx.fill();
        }

        // The filmed line
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = 'rgba(139,155,180,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx(FILMED, near), sy(0, near));
        ctx.lineTo(sx(FILMED, 120), sy(0, 120));
        ctx.stroke();
        ctx.setLineDash([]);

        // Your line: from under the camera, bending towards where you steer
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (var z = 1.6; z <= 90; z *= 1.08) {
          var s = Math.min(z / 22, 1);
          var lx = cam.x + (target.x - cam.x) * s * s * (3 - 2 * s);
          if (z === 1.6) ctx.moveTo(sx(lx, z), sy(0, z)); else ctx.lineTo(sx(lx, z), sy(0, z));
        }
        ctx.stroke();
        ctx.fillStyle = '#ccff00';
        ctx.shadowColor = 'rgba(204,255,0,0.8)';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(sx(cam.x, 2.2), sy(0, 2.2), Math.max(3, w * 0.012), 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Trees along both verges and bushes in front: silhouettes, lighter with distance
        var things = [];
        for (var i = 0; i < 16; i++) {
          var tz = i * 14 - (travelled % 14) + 2;
          things.push({ z: tz, x: -9, tree: true }, { z: tz + 7, x: 9.5, tree: true });
        }
        for (var j = 0; j < 14; j++) {
          var bz = j * 4.3 - (travelled % 4.3) + 1;
          things.push({ z: bz, x: j % 2 ? 4.2 : -4.2, tree: false, r: 0.35 + ((j * 7) % 5) * 0.08 });
        }
        things.sort(function (a, b) { return b.z - a.z; });
        things.forEach(function (o) {
          if (o.z < 0.6 || (o.tree && o.z < 3)) return;
          ctx.fillStyle = mix([3, 5, 9], [24, 46, 68], Math.min(o.z / 160, 1));
          var px = sx(o.x, o.z), scale = f / o.z;
          if (o.tree) {
            // Fades in on the far side so trees never pop up
            ctx.globalAlpha = Math.min(1, (200 - o.z) / 40);
            var trunkW = Math.max(0.3 * scale, 0.6);
            ctx.fillRect(px - trunkW / 2, sy(2.6, o.z), trunkW, sy(0, o.z) - sy(2.6, o.z));
            ctx.beginPath();
            ctx.ellipse(px, sy(4.4, o.z), 1.7 * scale, 2.1 * scale, 0, 0, Math.PI * 2);
            ctx.ellipse(px + 0.9 * scale * (o.x < 0 ? 1 : -1), sy(3.6, o.z), 1.2 * scale, 1.2 * scale, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          } else {
            ctx.beginPath();
            ctx.ellipse(px, sy(o.r * 0.6, o.z), o.r * 1.6 * scale, o.r * scale, 0, Math.PI, 0);
            ctx.fill();
          }
        });

        // Vignette
        var v = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.3, w / 2, h * 0.55, w * 0.75);
        v.addColorStop(0, 'rgba(5,7,11,0)');
        v.addColorStop(1, 'rgba(5,7,11,0.65)');
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, w, h);
      }

      // After the pointer leaves, the camera needs about 1.5 s to ease back onto the filmed line.
      kick = scene(box, draw, 1500);
      box.addEventListener('pointermove', function (e) {
        var r = box.getBoundingClientRect();
        var u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
        target.x = -2.7 + u * 5.4;
        target.h = 2.2 - v * 1.6;
        kick();
      });
      box.addEventListener('pointerleave', function () { target.x = FILMED; target.h = 1.1; kick(); });
    })();

    // Eight rounds to the beat: an audio editor without sound. The playhead sweeps a four-minute
    // track; passed bars light up, each work interval is marked as the playhead reaches it, the
    // meters follow the level, a dot pulses at 128 BPM, and a ghost cursor follows the pointer.
    (function () {
      var box = document.querySelector('[data-art="beat"]');
      var TRACK = 250, LOOP = 28, BPM = 128;
      var works = [];
      for (var i = 0; i < 8; i++) works.push(10 + i * 30);
      function isWork(s) { return works.some(function (a) { return s >= a && s < a + 20; }); }
      function noise(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
      var levels = [], levelsFor = 0;
      var ghost = null, peak = [0, 0];

      function clock(s) {
        var m = Math.floor(s / 60), r = s - m * 60;
        return '0' + m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
      }

      function draw(ctx, w, h, t) {
        var x0 = 12, x1 = w - 26, top = 24, bottom = h - 22;
        var span = x1 - x0, pitch = 2;
        var cols = Math.floor(span / pitch);
        if (levelsFor !== cols) {
          levels = [];
          for (var c = 0; c < cols; c++) {
            var s = (c / cols) * TRACK;
            var base = isWork(s) ? 0.78 : (s < 10 || s >= 250 ? 0.3 : 0.36);
            var swell = works.some(function (a) { return s > a - 3 && s < a; }) ? 0.2 : 0;
            levels.push(Math.min(1, base * (0.8 + 0.2 * noise(c)) + swell));
          }
          levelsFor = cols;
        }
        var p = ((t / 1000) % LOOP) / LOOP;
        var head = x0 + p * span;
        var now = p * TRACK;

        ctx.fillStyle = '#05070b';
        ctx.fillRect(0, 0, w, h);

        // Interval regions
        works.forEach(function (a) {
          var ax = x0 + (a / TRACK) * span, bx = x0 + ((a + 20) / TRACK) * span;
          ctx.fillStyle = 'rgba(232,168,56,0.07)';
          ctx.fillRect(ax, top, bx - ax, bottom - top);
        });

        // Ruler: a tick every 10 s, longer every 30 s
        ctx.strokeStyle = '#1b2a3c';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var s10 = 0; s10 <= TRACK; s10 += 10) {
          var rx = Math.round(x0 + (s10 / TRACK) * span) + 0.5;
          ctx.moveTo(rx, 14); ctx.lineTo(rx, s10 % 30 === 10 ? 6 : 10);
        }
        ctx.moveTo(x0, 14.5); ctx.lineTo(x1, 14.5);
        ctx.stroke();

        // Level bars standing on the baseline, like a workout chart; played bars in colour
        for (var k = 0; k < cols; k++) {
          var bx2 = x0 + k * pitch;
          var amp = levels[k] * (bottom - top) * 0.95;
          var played = bx2 < head;
          var work = isWork((k / cols) * TRACK);
          ctx.fillStyle = played ? (work ? '#e8a838' : '#1aa3c9') : (work ? '#3a3a3a' : '#223044');
          ctx.fillRect(bx2, bottom - amp, pitch - 0.8, amp);
        }

        // Markers at each work start, set as the playhead passes
        works.forEach(function (a) {
          var mx = Math.round(x0 + (a / TRACK) * span) + 0.5;
          if (mx > head) return;
          var age = (head - mx) / span * LOOP;
          ctx.globalAlpha = Math.min(1, age * 4);
          ctx.strokeStyle = '#ccff00';
          ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(mx, top); ctx.lineTo(mx, bottom); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#ccff00';
          ctx.beginPath(); ctx.moveTo(mx, 15); ctx.lineTo(mx + 5, 18); ctx.lineTo(mx, 21); ctx.fill();
          ctx.globalAlpha = 1;
        });

        // Ghost cursor under the pointer
        if (ghost !== null) {
          var gx = Math.round(x0 + ghost * span) + 0.5;
          ctx.strokeStyle = 'rgba(139,155,180,0.55)';
          ctx.beginPath(); ctx.moveTo(gx, 6); ctx.lineTo(gx, bottom); ctx.stroke();
        }

        // Playhead
        ctx.strokeStyle = '#f1f5f9';
        ctx.lineWidth = 1.5;
        ctx.shadowColor = 'rgba(241,245,249,0.6)';
        ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.moveTo(head, 8); ctx.lineTo(head, bottom + 4); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#f1f5f9';
        ctx.beginPath(); ctx.moveTo(head - 4.5, 4); ctx.lineTo(head + 4.5, 4); ctx.lineTo(head, 10); ctx.fill();
        ctx.lineWidth = 1;

        // Level meters with peak hold, from the level under the playhead
        var lvl = levels[Math.min(cols - 1, Math.floor(p * cols))] || 0;
        var mx0 = w - 18, mTop = top, mBottom = bottom;
        [0, 1].forEach(function (ch) {
          var jitter = stillMotion ? 0.9 : 0.82 + 0.18 * Math.sin(t / (ch ? 47 : 61) + ch);
          var v = Math.min(1, lvl * jitter * 1.08);
          peak[ch] = Math.max(v, peak[ch] - 0.006);
          for (var y = mBottom; y > mBottom - (mBottom - mTop) * v; y -= 3) {
            var share = (mBottom - y) / (mBottom - mTop);
            ctx.fillStyle = share > 0.82 ? '#e8a838' : '#ccff00';
            ctx.fillRect(mx0 + ch * 6, y - 2, 4, 2);
          }
          ctx.fillStyle = '#f1f5f9';
          ctx.fillRect(mx0 + ch * 6, mBottom - (mBottom - mTop) * peak[ch] - 1, 4, 1);
        });

        // Beat dot at 128 BPM
        var beat = ((t / 1000) * BPM / 60) % 1;
        ctx.fillStyle = 'rgba(204,255,0,' + (stillMotion ? 0.9 : 1 - beat * 0.85) + ')';
        ctx.beginPath(); ctx.arc(w - 13, 11, 2.5 + (stillMotion ? 0 : (1 - beat) * 1.5), 0, Math.PI * 2); ctx.fill();

        // Countdown before each work block: 3, 2, 1 over the last 9 s of the rest, then WORK.
        // Each word pops in slightly larger and settles while it fades.
        var call = null, phase = 0;
        works.forEach(function (a) {
          var before = a - now;
          if (before > 0 && before <= 9) { call = String(Math.ceil(before / 3)); phase = 1 - (before % 3 || 3) / 3; }
          else if (before <= 0 && before > -5) { call = 'WORK'; phase = -before / 5; }
        });
        if (call) {
          var size = (bottom - top) * (call === 'WORK' ? 0.42 : 0.62) * (1.15 - 0.15 * Math.min(phase * 3, 1));
          ctx.save();
          ctx.globalAlpha = 1 - phase * 0.7;
          ctx.font = 'italic 700 ' + size.toFixed(1) + 'px "Chakra Petch", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(5,7,11,0.9)';
          ctx.shadowBlur = 12;
          ctx.fillStyle = call === 'WORK' ? '#ccff00' : '#f1f5f9';
          ctx.fillText(call, x0 + span / 2, (top + bottom) / 2);
          ctx.restore();
        }

        // Timecode
        ctx.font = '500 9px "JetBrains Mono", ui-monospace, monospace';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#f1f5f9';
        ctx.fillText(clock(now), x0, h - 7);
        ctx.fillStyle = '#5b6b82';
        ctx.textAlign = 'right';
        ctx.fillText(clock(TRACK), x1, h - 7);
        ctx.textAlign = 'left';
      }

      var kick = scene(box, draw);
      box.addEventListener('pointermove', function (e) {
        var r = box.getBoundingClientRect();
        var u = (e.clientX - r.left - 12) / (r.width - 38);
        ghost = u >= 0 && u <= 1 ? u : null;
        kick();
      });
      box.addEventListener('pointerleave', function () { ghost = null; kick(); });
    })();

    // Every metre, its frame: how distance on the GPX track maps to time in the video. A straight
    // line between sparse GPX points gives the camera a constant speed per segment that jumps at
    // every point (dashed steps, right); a smooth fit, with the video's own motion, changes speed
    // gently (cyan). Left, the video: motion vectors stream out of the vanishing point at that
    // smooth speed. The lime dot rides the fit, the hollow one the GPX steps.
    (function () {
      var box = document.querySelector('[data-art="gpx"]');
      var LOOP = 9;
      // Video time as a share of the clip, for a share of the distance: monotone, slower uphill.
      function smooth(d) { return d + 0.06 * Math.sin(d * Math.PI * 3); }
      var gpx = [0, 0.17, 0.38, 0.55, 0.8, 1].map(function (d) { return [d, smooth(d)]; });
      function segment(d) {
        for (var k = 0; k < gpx.length - 2; k++) if (d < gpx[k + 1][0]) return k;
        return gpx.length - 2;
      }
      function onGpx(d) {
        var a = gpx[segment(d)], b = gpx[segment(d) + 1];
        return a[1] + (b[1] - a[1]) * (d - a[0]) / (b[0] - a[0]);
      }
      // Camera speed is distance per video time: the inverse of each mapping's slope
      function smoothSpeed(d) { return 1 / (1 + 0.06 * Math.PI * 3 * Math.cos(d * Math.PI * 3)); }
      function gpxSpeed(d) { var a = gpx[segment(d)], b = gpx[segment(d) + 1]; return (b[0] - a[0]) / (b[1] - a[1]); }
      var TOP_SPEED = 2.6;
      // Distance at a video time, by bisection (both mappings rise with distance)
      function inverse(fn, u) {
        var lo = 0, hi = 1;
        for (var n = 0; n < 24; n++) { var m = (lo + hi) / 2; if (fn(m) < u) lo = m; else hi = m; }
        return (lo + hi) / 2;
      }
      var flow = [];
      for (var j = 0; j < 46; j++) flow.push({ x: -4 + ((j * 37) % 80) / 10, z: 2 + ((j * 53) % 380) / 10 });
      var last = 0;

      function draw(ctx, w, h, t) {
        var dt = last ? Math.min((t - last) / 1000, 0.1) : 0;
        last = t;
        var u = ((t / 1000) % LOOP) / LOOP;
        var dNow = inverse(smooth, u);
        var speed = 9 * smoothSpeed(dNow);

        ctx.fillStyle = '#05070b';
        ctx.fillRect(0, 0, w, h);

        // Left: the video frame
        var vx = 10, vy = 12, vw = w * 0.42, vh = h - 24;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(vx, vy, vw, vh, 6);
        ctx.clip();
        var sky = ctx.createLinearGradient(0, vy, 0, vy + vh);
        sky.addColorStop(0, '#0a1422');
        sky.addColorStop(0.42, '#14283e');
        sky.addColorStop(0.43, '#0b1522');
        sky.addColorStop(1, '#070c14');
        ctx.fillStyle = sky;
        ctx.fillRect(vx, vy, vw, vh);
        var hz = vy + vh * 0.42, cx = vx + vw / 2, f = vw * 0.7;
        function px(x, z) { return cx + (f * x) / z; }
        function py(z) { return hz + (f * 1.2) / z; }
        ctx.strokeStyle = '#3d4b60';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px(-3, 0.8), py(0.8)); ctx.lineTo(cx, hz);
        ctx.lineTo(px(3, 0.8), py(0.8));
        ctx.stroke();
        flow.forEach(function (p) {
          p.z -= speed * dt;
          if (p.z < 1.2) p.z += 38;
          var z0 = p.z, z1 = p.z + speed * 0.12;
          ctx.strokeStyle = 'rgba(0,240,255,' + Math.min(0.9, 6 / z0).toFixed(2) + ')';
          ctx.beginPath();
          ctx.moveTo(px(p.x, z1), py(z1));
          ctx.lineTo(px(p.x, z0), py(z0));
          ctx.stroke();
        });
        ctx.fillStyle = '#ccff00';
        ctx.beginPath(); ctx.arc(cx, hz, 2, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.strokeStyle = '#1b2a3c';
        ctx.beginPath(); ctx.roundRect(vx + 0.5, vy + 0.5, vw - 1, vh - 1, 6); ctx.stroke();

        // Right: camera speed over distance
        var gx = vx + vw + 18, gy = vy + 4, gw = w - gx - 12, gh = vh - 14;
        function X(d) { return gx + d * gw; }
        function Y(v) { return gy + gh - (v / TOP_SPEED) * gh; }
        ctx.strokeStyle = '#1b2a3c';
        ctx.beginPath();
        ctx.moveTo(gx + 0.5, gy); ctx.lineTo(gx + 0.5, gy + gh + 0.5); ctx.lineTo(gx + gw, gy + gh + 0.5);
        ctx.stroke();

        // GPX only: steps, jumping at each track point (dots on the axis)
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#8b9bb4';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        for (var k = 0; k < gpx.length - 1; k++) {
          var v = (gpx[k + 1][0] - gpx[k][0]) / (gpx[k + 1][1] - gpx[k][1]);
          if (k) ctx.lineTo(X(gpx[k][0]), Y(v)); else ctx.moveTo(X(gpx[k][0]), Y(v));
          ctx.lineTo(X(gpx[k + 1][0]), Y(v));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.fillStyle = '#8b9bb4';
        gpx.forEach(function (p) { ctx.beginPath(); ctx.arc(X(p[0]), gy + gh + 0.5, 2, 0, Math.PI * 2); ctx.fill(); });

        // The smooth fit
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (var s = 0; s <= 80; s++) {
          var dd = s / 80;
          if (s) ctx.lineTo(X(dd), Y(smoothSpeed(dd))); else ctx.moveTo(X(dd), Y(smoothSpeed(dd)));
        }
        ctx.stroke();
        ctx.lineWidth = 1;

        // Where each mapping is at this video time
        var dG = inverse(onGpx, u);
        ctx.strokeStyle = 'rgba(241,245,249,0.18)';
        ctx.beginPath(); ctx.moveTo(Math.round(X(dNow)) + 0.5, gy); ctx.lineTo(Math.round(X(dNow)) + 0.5, gy + gh); ctx.stroke();
        ctx.strokeStyle = '#8b9bb4';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(X(dG), Y(gpxSpeed(dG)), 3.5, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = '#ccff00';
        ctx.shadowColor = 'rgba(204,255,0,0.8)';
        ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(X(dNow), Y(smoothSpeed(dNow)), 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;

        // Axis names
        ctx.font = '500 8px "JetBrains Mono", ui-monospace, monospace';
        ctx.fillStyle = '#5b6b82';
        ctx.textAlign = 'right';
        ctx.fillText('distance', gx + gw, gy + gh + 11);
        ctx.save();
        ctx.translate(gx - 5, gy);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('speed', 0, 0);
        ctx.restore();
        ctx.textAlign = 'left';
      }

      scene(box, draw);
    })();

    // Copy the commands without the prompts and comments.
    (function () {
      var button = document.getElementById('copy');
      if (!navigator.clipboard) return;
      button.hidden = false;
      button.addEventListener('click', function () {
        var text = document.getElementById('commands').textContent
          .split('\\n')
          .filter(function (line) { return line.indexOf('$ ') === 0; })
          .map(function (line) { return line.slice(2); })
          .join('\\n');
        navigator.clipboard.writeText(text).then(function () {
          button.textContent = 'Copied';
          button.setAttribute('data-done', '');
          setTimeout(function () { button.textContent = 'Copy'; button.removeAttribute('data-done'); }, 1800);
        });
      });
    })();
  </script>
</body>
</html>`;
