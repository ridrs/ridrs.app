// Inline SVG icons (16 px, currentColor, decorative). They replace emoji and text glyphs.
const P = {
  check: '<path d="M3 8.5l3.2 3.2L13 5"/>',
  cross: '<path d="M4 4l8 8M12 4l-8 8"/>',
  warning: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 7v2.6M8 11.4v.2"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.9M8 4.8v.2"/>',
  spinner: '<path d="M8 2a6 6 0 1 0 6 6"/>',
  play: '<path d="M5 3.2v9.6L12.8 8z" fill="currentColor"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2.2"/>',
  folder: '<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>',
  link: '<path d="M6.5 9.5l3-3M7.2 4.6l.9-.9a2.5 2.5 0 0 1 3.5 3.5l-.9.9M8.8 11.4l-.9.9a2.5 2.5 0 0 1-3.5-3.5l.9-.9"/>',
  download: '<path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3 10.5v-7a1 1 0 0 1 1-1h6.5"/>',
  map: '<path d="M2 4l4-1.5 4 1.5 4-1.5v9.5l-4 1.5-4-1.5-4 1.5z"/><path d="M6 2.5V12M10 4v9.5"/>',
  wrench: '<path d="M10 2.5a3.5 3.5 0 0 0-3.3 4.7L2.5 11.4l2.1 2.1 4.2-4.2A3.5 3.5 0 0 0 13.5 6l-2 2-1.9-.6-.6-1.9 2-2c-.3-.1-.7-.1-1-.1z"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></g>',
  chevron: '<path d="M6 3.5l4.5 4.5L6 12.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 9h5.8l.6-9"/>',
  film: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 3v10M11 3v10M2 6.5h3M2 9.5h3M11 6.5h3M11 9.5h3"/>',
  route: '<circle cx="4" cy="12" r="1.5"/><circle cx="12" cy="4" r="1.5"/><path d="M5.5 12H10a2 2 0 0 0 0-4H6a2 2 0 0 1 0-4h4.5"/>',
  circle: '<circle cx="8" cy="8" r="5.5"/>',
  minus: '<path d="M4 8h8"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  expand: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.8" cy="6.3" r="1.1"/><path d="M2.5 11.5l3.5-3 2.5 2 2-1.5 3 2.5"/>',
  edit: '<path d="M3 13l.6-2.8 7-7 2.2 2.2-7 7z"/>',
} as const;
export type IconName = keyof typeof P;

export function icon(name: IconName, cls = ""): SVGSVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", `icon icon-${name}${cls ? " " + cls : ""}`);
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  s.innerHTML = P[name];
  return s;
}
