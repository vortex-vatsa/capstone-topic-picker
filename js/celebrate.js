// Hand-drawn celebrations on one canvas: paper confetti for small wins, and a fall of chocolates
// (foil-wrapped truffles, segmented squares, gold flecks) for the reveal. No images: every piece
// is drawn with the canvas API. Purely decorative, so nothing plays under reduced motion.

import { prefersReducedMotion } from "./dom.js";

// The page is wine-red, so confetti and foils use the topic flavours, which stay visible on it.
const PAPER_COLORS = ["#f2c089", "#f8d4a8", "#fbedee", "#ff9eb0", "#bfd69a", "#e9b06f"];
const FOILS = {
  gold: { light: "#f4e0a6", mid: "#c9a45c", dark: "#6f5222" },
  pistachio: { light: "#e3f0cc", mid: "#9fbb73", dark: "#4d6131" },
  brown: { light: "#b88a66", mid: "#6b4026", dark: "#2a170c" },
};
const MAX_PARTICLES = 700;

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("celebration"));
const ctx = canvas.getContext("2d");
let particles = [];
let running = false;
let lastTime = 0;
let sprites = null;

/**
 * One burst of paper confetti.
 * @param {{ x?: number, y?: number, count?: number, spread?: number, angle?: number, power?: number }} options
 *   x/y are fractions of the viewport; angle is degrees from horizontal (90 = straight up).
 */
export function confetti({ x = 0.5, y = 0.4, count = 120, spread = 70, angle = 90, power = 1 } = {}) {
  if (prefersReducedMotion()) return;
  resize();
  const room = Math.max(0, MAX_PARTICLES - particles.length);
  for (let i = 0; i < Math.min(count, room); i++) {
    const direction = ((angle + (Math.random() - 0.5) * spread) * Math.PI) / 180;
    const speed = (6 + Math.random() * 8) * power;
    particles.push({
      kind: "paper",
      x: x * window.innerWidth,
      y: y * window.innerHeight,
      vx: Math.cos(direction) * speed,
      vy: -Math.sin(direction) * speed,
      gravity: 0.3,
      drag: 0.985,
      sway: 1.2,
      size: 5 + Math.random() * 6,
      color: PAPER_COLORS[Math.floor(Math.random() * PAPER_COLORS.length)],
      ...spinState(0.3),
      delay: 0,
      life: 0,
      maxLife: 240 + Math.random() * 100,
    });
  }
  start();
}

/**
 * The reveal: chocolates fall gently from the top while two volleys of confetti go up.
 * @returns {boolean} false when nothing played (reduced motion), so the caller can say so in words
 */
export function finale() {
  if (prefersReducedMotion()) return false;
  resize();
  sprites ??= buildSprites();

  const width = window.innerWidth;
  const pieces = width < 600 ? 28 : 46;
  for (let i = 0; i < pieces; i++) {
    const roll = Math.random();
    const sprite =
      roll < 0.22 ? sprites.truffle.gold
      : roll < 0.36 ? sprites.truffle.pistachio
      : roll < 0.5 ? sprites.truffle.brown
      : sprites.square;
    particles.push(fallingPiece({ kind: "sprite", sprite }));
  }
  for (let i = 0; i < pieces; i++) {
    particles.push(fallingPiece({ kind: "fleck", size: 3 + Math.random() * 4 }));
  }

  confetti({ x: 0.08, y: 1, angle: 65, spread: 30, power: 1.4, count: 80 });
  setTimeout(() => confetti({ x: 0.92, y: 1, angle: 115, spread: 30, power: 1.4, count: 80 }), 260);
  start();
  return true;
}

function fallingPiece(fields) {
  return {
    x: Math.random() * window.innerWidth,
    y: -40 - Math.random() * 60,
    vx: (Math.random() - 0.5) * 0.6,
    vy: 1 + Math.random() * 1.5,
    // Light gravity against heavy drag gives a slow terminal velocity: a fall, not a drop.
    gravity: 0.035,
    drag: 0.99,
    sway: 0.4 + Math.random() * 0.6,
    ...spinState(0.04),
    // Staggered over ~2.5 s so the pieces arrive as a shower rather than a wall.
    delay: Math.random() * 150,
    life: 0,
    maxLife: Infinity,
    ...fields,
  };
}

function spinState(maxSpin) {
  return {
    rotation: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * maxSpin,
    wobble: Math.random() * Math.PI * 2,
    wobbleSpeed: 0.03 + Math.random() * 0.05,
  };
}

// ---- animation loop -----------------------------------------------------------------------------

function start() {
  if (running) return;
  running = true;
  lastTime = performance.now();
  requestAnimationFrame(tick);
}

function tick(now) {
  // Normalise to 60 fps so motion looks the same on 120 Hz screens and after a background tab.
  const step = Math.min(3, (now - lastTime) / (1000 / 60));
  lastTime = now;
  const height = window.innerHeight;

  ctx.clearRect(0, 0, window.innerWidth, height);
  particles = particles.filter((p) => p.y < height + 60 && p.life < p.maxLife);

  for (const p of particles) {
    if (p.delay > 0) {
      p.delay -= step;
      continue;
    }
    p.life += step;
    p.vx *= p.drag ** step;
    p.vy = p.vy * p.drag ** step + p.gravity * step;
    p.wobble += p.wobbleSpeed * step;
    p.x += (p.vx + Math.sin(p.wobble) * p.sway) * step;
    p.y += p.vy * step;
    p.rotation += p.spin * step;
    draw(p);
  }

  if (particles.length > 0) {
    requestAnimationFrame(tick);
  } else {
    running = false;
    ctx.clearRect(0, 0, window.innerWidth, height);
  }
}

function draw(p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rotation);
  if (p.kind === "sprite") {
    const { image, width, height } = p.sprite;
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
  } else if (p.kind === "fleck") {
    // A torn scrap of foil: an irregular quad that catches the light as it turns.
    ctx.scale(1, Math.cos(p.wobble));
    ctx.fillStyle = FOILS.gold.mid;
    ctx.beginPath();
    ctx.moveTo(-p.size / 2, -p.size / 3);
    ctx.lineTo(p.size / 2, -p.size / 2);
    ctx.lineTo(p.size / 3, p.size / 2);
    ctx.lineTo(-p.size / 2, p.size / 3);
    ctx.fill();
  } else {
    const fade = Math.min(1, (p.maxLife - p.life) / 40);
    ctx.globalAlpha = Math.max(0, fade);
    // Scaling by cos(wobble) fakes a strip of paper turning over in the air.
    ctx.scale(1, Math.cos(p.wobble));
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
  }
  ctx.restore();
}

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(window.innerWidth * ratio);
  const height = Math.round(window.innerHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

window.addEventListener("resize", () => {
  if (running) resize();
});

// ---- chocolate sprites --------------------------------------------------------------------------
// Each piece is painted once to an offscreen canvas, then stamped with drawImage every frame.

function buildSprites() {
  return {
    truffle: {
      gold: paintSprite(46, 26, (c) => truffle(c, FOILS.gold)),
      pistachio: paintSprite(46, 26, (c) => truffle(c, FOILS.pistachio)),
      brown: paintSprite(46, 26, (c) => truffle(c, FOILS.brown)),
    },
    square: paintSprite(24, 24, square),
  };
}

function paintSprite(width, height, paint) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const image = document.createElement("canvas");
  image.width = Math.ceil(width * ratio);
  image.height = Math.ceil(height * ratio);
  const c = image.getContext("2d");
  c.scale(ratio, ratio);
  c.translate(width / 2, height / 2);
  paint(c);
  return { image, width, height };
}

/** A round truffle in foil, twisted closed at both ends. Drawn centred in a 46 × 26 box. */
function truffle(c, foil) {
  const r = 10;

  // Twisted ends: a pleated fan either side of the ball.
  for (const side of [-1, 1]) {
    c.beginPath();
    c.moveTo(side * (r - 2), 0);
    c.lineTo(side * (r + 12), -8);
    c.quadraticCurveTo(side * (r + 14), 0, side * (r + 12), 8);
    c.closePath();
    c.fillStyle = foil.mid;
    c.fill();
    c.strokeStyle = foil.dark;
    c.lineWidth = 0.6;
    for (const y of [-5, -1.5, 2, 5.5]) {
      c.beginPath();
      c.moveTo(side * (r + 1), y * 0.3);
      c.lineTo(side * (r + 12), y);
      c.stroke();
    }
  }

  const body = c.createRadialGradient(-r * 0.35, -r * 0.4, 1, 0, 0, r);
  body.addColorStop(0, foil.light);
  body.addColorStop(0.55, foil.mid);
  body.addColorStop(1, foil.dark);
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fillStyle = body;
  c.fill();

  // Crinkles in the foil.
  c.strokeStyle = foil.dark;
  c.globalAlpha = 0.35;
  c.lineWidth = 0.7;
  for (const [start, end, radius] of [[0.2, 1.1, 6], [2.4, 3.3, 7.5], [3.9, 4.7, 4.5]]) {
    c.beginPath();
    c.arc(0, 0, radius, start, end);
    c.stroke();
  }
  c.globalAlpha = 0.55;
  c.fillStyle = "#fff8e6";
  c.beginPath();
  c.ellipse(-r * 0.38, -r * 0.45, 2.6, 1.4, -0.6, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = 1;
}

/** A square of dark chocolate moulded into four segments, like a piece snapped off a bar. */
function square(c) {
  const half = 11;
  const radius = 2;
  c.fillStyle = "#4a2c1a";
  roundedRect(c, -half, -half, half * 2, half * 2, radius);
  c.fill();

  // Bevel: light catches the top-left edges, shadow pools bottom-right.
  c.lineWidth = 1.2;
  c.strokeStyle = "#7d5236";
  c.beginPath();
  c.moveTo(-half + 1, half - 2);
  c.lineTo(-half + 1, -half + 1);
  c.lineTo(half - 2, -half + 1);
  c.stroke();
  c.strokeStyle = "#1f1109";
  c.beginPath();
  c.moveTo(half - 1, -half + 2);
  c.lineTo(half - 1, half - 1);
  c.lineTo(-half + 2, half - 1);
  c.stroke();

  // Grooves between the segments, each with a highlight just below/right of it.
  c.lineWidth = 1.2;
  c.strokeStyle = "#1f1109";
  c.beginPath();
  c.moveTo(0, -half + 2);
  c.lineTo(0, half - 2);
  c.moveTo(-half + 2, 0);
  c.lineTo(half - 2, 0);
  c.stroke();
  c.lineWidth = 0.8;
  c.strokeStyle = "#6b4329";
  c.beginPath();
  c.moveTo(1.2, -half + 2);
  c.lineTo(1.2, half - 2);
  c.moveTo(-half + 2, 1.2);
  c.lineTo(half - 2, 1.2);
  c.stroke();
}

function roundedRect(c, x, y, width, height, radius) {
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + width, y, x + width, y + height, radius);
  c.arcTo(x + width, y + height, x, y + height, radius);
  c.arcTo(x, y + height, x, y, radius);
  c.arcTo(x, y, x + width, y, radius);
  c.closePath();
}
