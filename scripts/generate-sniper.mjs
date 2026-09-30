#!/usr/bin/env node
/**
 * Sniper vs contribution graph.
 *
 * Fetches a user's contribution calendar and renders an animated SVG where a
 * rifle scope hunts down the active cells one by one. Writes:
 *   <out>/sniper-dark.svg, <out>/sniper-light.svg  - for the profile README
 *   <out>/contributions.json                       - for the interactive range (site/)
 *
 * Usage:
 *   GITHUB_TOKEN=... node scripts/generate-sniper.mjs [user] [outDir]
 *
 * Without GITHUB_TOKEN it tries a public contributions API and falls back to
 * demo data, so the script can be run locally with zero setup.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const USER = process.argv[2] || process.env.GITHUB_USER || 'kitneybean';
const OUT_DIR = process.argv[3] || process.env.OUT_DIR || 'dist';
const TOKEN = process.env.GITHUB_TOKEN || '';

const MAX_TARGETS = 36;
const MIN_TARGETS = 10;

// ---------------------------------------------------------------- layout ---
const CELL = 11;
const GAP = 4;
const STRIDE = CELL + GAP;
const GRID_X = 46;
const GRID_Y = 64;
const RIFLE_ZONE = 150;
const H = 232;
const SCOPE_R = 34;

// ---------------------------------------------------------------- timing ---
const AIM = 0.38; // hold on target before the trigger pull
const BULLET = 0.07; // muzzle -> target
const SETTLE = 0.3; // recoil recovery
const EPS = 0.01;

const RIFLE_SCALE = 0.72;
const MUZZLE_L = 188; // barrel tip, in rifle-local units
const REST_ROT = -6; // rifle angle while nobody is being shot

const THEMES = {
  dark: {
    bg: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#7d8590',
    levels: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
    cellStroke: 'rgba(240,246,252,0.05)',
    accent: '#ff4d4d', ember: '#ff7b3d', crater: '#2b1510', hole: '#010409',
    vignette: '#010409', vignetteOpacity: 0.5,
    ring: '#484f58', post: '#c9d1d9', smoke: '#8b949e',
    tracer: '#ffd27a', gun: '#444c56', gunEdge: '#8b949e', gunDark: '#2d333b', brass: '#d4a73c',
    bannerBg: '#0d1117',
  },
  light: {
    bg: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#59636e',
    levels: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    cellStroke: 'rgba(31,35,40,0.06)',
    accent: '#cf222e', ember: '#bc4c00', crater: '#e3cfc4', hole: '#1f2328',
    vignette: '#1f2328', vignetteOpacity: 0.32,
    ring: '#1f2328', post: '#1f2328', smoke: '#8c959f',
    tracer: '#bf8700', gun: '#3b434d', gunEdge: '#8c959f', gunDark: '#24292f', brass: '#bf8700',
    bannerBg: '#ffffff',
  },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ------------------------------------------------------------------ data ---
const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function fromGraphQL(user, token) {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{
    totalContributions weeks{contributionDays{date contributionCount contributionLevel}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'sniper-contributions',
    },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL: HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GitHub GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  const cal = json.data.user.contributionsCollection.contributionCalendar;
  const days = cal.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount, level: LEVELS[d.contributionLevel] ?? 0 }));
  return { total: cal.totalContributions, days, source: 'github' };
}

async function fromPublicApi(user) {
  const res = await fetch(`https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(user)}?y=last`);
  if (!res.ok) throw new Error(`public API: HTTP ${res.status}`);
  const json = await res.json();
  const days = json.contributions.map((d) => ({ date: d.date, count: d.count, level: d.level }));
  return { total: json.total?.lastYear ?? days.reduce((s, d) => s + d.count, 0), days, source: 'public-api' };
}

function demoData(rng) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const days = [];
  for (let i = 364; i >= 0; i--) {
    const date = new Date(end.getTime() - i * 864e5).toISOString().slice(0, 10);
    const busy = Math.sin(i / 23) * 0.8 + rng() * 1.7 - 0.5;
    const level = busy < 0.35 ? 0 : Math.min(4, Math.ceil(busy * 1.7));
    days.push({ date, count: level ? level * 3 + Math.floor(rng() * 3) : 0, level });
  }
  return { total: days.reduce((s, d) => s + d.count, 0), days, source: 'demo' };
}

async function loadData(rng) {
  if (TOKEN) return fromGraphQL(USER, TOKEN); // in CI a failure must fail the job, not publish demo data
  try {
    return await fromPublicApi(USER);
  } catch (err) {
    console.warn(`! ${err.message} - falling back to demo data`);
    return demoData(rng);
  }
}

// --------------------------------------------------------------- helpers ---
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

function toGrid(days) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const offset = weekday(sorted[0].date);
  return sorted.map((d, i) => {
    const col = Math.floor((i + offset) / 7);
    const row = (i + offset) % 7;
    return { ...d, col, row, x: GRID_X + col * STRIDE, y: GRID_Y + row * STRIDE };
  });
}

/** Columns where a month starts; a month squeezed into < 3 columns gives way to the next one. */
function monthMarks(cells, cols) {
  const marks = [];
  for (let col = 0; col < cols; col++) {
    const first = cells.find((c) => c.col === col);
    const month = new Date(`${first.date}T00:00:00Z`).getUTCMonth();
    if (marks.at(-1)?.month !== month) marks.push({ col, month });
  }
  return marks.filter((m, i) => (marks[i + 1]?.col ?? cols) - m.col >= 3);
}

/** Weighted sample (busier days are juicier targets), then a nearest-neighbour route. */
function pickTargets(cells, rng, start) {
  const active = cells.filter((c) => c.level > 0);
  let picked = active
    .map((c) => ({ c, k: rng() ** (1 / (c.level + 0.5)) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, MAX_TARGETS)
    .map((o) => o.c);

  if (picked.length < MIN_TARGETS) {
    const empty = cells.filter((c) => c.level === 0).sort(() => rng() - 0.5);
    picked = picked.concat(empty.slice(0, MIN_TARGETS - picked.length));
  }

  const route = [];
  let cur = start;
  const left = new Set(picked);
  while (left.size) {
    let best = null;
    let bestD = Infinity;
    for (const c of left) {
      const d = Math.hypot(c.x - cur.x, c.y - cur.y);
      if (d < bestD) [best, bestD] = [c, d];
    }
    left.delete(best);
    route.push(best);
    cur = best;
  }
  return route;
}

// ------------------------------------------------------------- timeline ---
function buildTimeline(targets, W) {
  const pivot = { x: W - 64, y: H - 34 };
  const offscreen = { x: W + 90, y: GRID_Y + 3 * STRIDE };
  const center = (c) => ({ x: c.x + CELL / 2, y: c.y + CELL / 2 });

  // Rifle rotation towards p. The barrel is drawn along -x; like in a shooter the
  // angle is damped so close targets don't make the rifle stand on its butt.
  const aimRot = (p) => {
    const deg = (Math.atan2(p.y - pivot.y, p.x - pivot.x) * 180) / Math.PI - 180;
    const raw = ((((deg + 180) % 360) + 360) % 360) - 180;
    return REST_ROT + clamp(raw - REST_ROT, -10, 70) * 0.55;
  };

  const scope = [{ t: 0, ...offscreen, rot: REST_ROT, ease: 'ease-in-out' }];
  const shots = [];
  let t = 0.25;
  let cur = offscreen;
  scope.push({ t, ...offscreen, rot: REST_ROT, ease: 'ease-in-out' });

  for (const cell of targets) {
    const p = center(cell);
    const travel = clamp(0.28 + Math.hypot(p.x - cur.x, p.y - cur.y) * 0.0016, 0.34, 1.0);
    const rot = aimRot(p);
    t += travel;
    scope.push({ t, ...p, rot });
    t += AIM;
    scope.push({ t, ...p, rot, ease: 'ease-out' });
    const tShot = t;
    scope.push({ t: t + 0.05, x: p.x + 1.5, y: p.y - 9, rot: rot + 1.5, ease: 'ease-in-out' });
    t += SETTLE;
    scope.push({ t, ...p, rot, ease: 'ease-in-out' });
    const theta = ((rot + 180) * Math.PI) / 180;
    shots.push({
      cell,
      p,
      tShot,
      tHit: tShot + BULLET,
      muzzle: {
        x: pivot.x + Math.cos(theta) * MUZZLE_L * RIFLE_SCALE,
        y: pivot.y + Math.sin(theta) * MUZZLE_L * RIFLE_SCALE,
      },
      port: {
        x: pivot.x + (Math.cos(theta) * 20 - Math.sin(theta) * 8) * RIFLE_SCALE,
        y: pivot.y + (Math.sin(theta) * 20 + Math.cos(theta) * 8) * RIFLE_SCALE,
      },
    });
    cur = p;
  }

  const tDone = t + 0.3;
  const bannerIn = tDone + 0.2;
  scope.push({ t: tDone + 0.5, ...cur, rot: aimRot(cur), ease: 'ease-in' });
  scope.push({ t: tDone + 1.5, ...offscreen, rot: REST_ROT });
  const tRespawn = bannerIn + 2.9;
  const T = tRespawn + 1.3;
  const vignette = { in: [0.25, 0.9], out: [tDone + 0.6, tDone + 1.4] };
  return { T, pivot, offscreen, scope, shots, tDone, bannerIn, tRespawn, vignette };
}

// ------------------------------------------------------------------ css ----
const pct = (t, T) => `${Math.round((t / T) * 100000) / 1000}%`;

/** frames: [[timeSec, 'css declarations'], ...] */
function keyframes(name, frames, T) {
  const sorted = [...frames].sort((a, b) => a[0] - b[0]);
  if (sorted[0][0] > 0) sorted.unshift([0, sorted[0][1]]);
  if (sorted.at(-1)[0] < T) sorted.push([T, sorted.at(-1)[1]]);
  return `@keyframes ${name}{${sorted.map(([t, css]) => `${pct(Math.min(t, T), T)}{${css}}`).join('')}}`;
}

/** Shared one-shot effect: starts at 0 and is invisible for the rest of the loop. */
function oneShot(name, frames, T) {
  return keyframes(name, [...frames, [T, frames.at(-1)[1]]], T);
}

// --------------------------------------------------------------- render ----
function renderSvg({ cells, timeline, total, user, theme: th, updated }) {
  const { T, pivot, offscreen, scope, shots, bannerIn, tRespawn, vignette } = timeline;
  const cols = Math.max(...cells.map((c) => c.col)) + 1;
  const gridW = cols * STRIDE - GAP;
  const W = GRID_X + gridW + RIFLE_ZONE;
  const gridBottom = GRID_Y + 7 * STRIDE - GAP;
  const K = shots.length;
  const css = [];
  const out = [];

  // Motion: scope position, rifle aim, rifle recoil
  css.push(
    keyframes(
      'scope',
      scope.map((f) => [f.t, `transform:translate(${r2(f.x)}px,${r2(f.y)}px)${f.ease ? `;animation-timing-function:${f.ease}` : ''}`]),
      T,
    ),
    keyframes(
      'aim',
      scope.map((f) => [f.t, `transform:rotate(${r2(f.rot)}deg)${f.ease ? `;animation-timing-function:${f.ease}` : ''}`]),
      T,
    ),
  );

  const still = 'transform:translate(0px,0px) rotate(0deg)';
  const kick = [[0, still]];
  const muzzle = [[0, 'opacity:0']];
  const marker = [[0, 'opacity:0']];
  for (const s of shots) {
    kick.push([s.tShot - EPS, still], [s.tShot + 0.04, 'transform:translate(10px,0px) rotate(4deg)'], [s.tShot + 0.26, still]);
    muzzle.push([s.tShot - EPS, 'opacity:0'], [s.tShot, 'opacity:1'], [s.tShot + 0.07, 'opacity:0']);
    marker.push([s.tHit - EPS, 'opacity:0'], [s.tHit, 'opacity:1'], [s.tHit + 0.2, 'opacity:1'], [s.tHit + 0.3, 'opacity:0']);
  }
  css.push(keyframes('kick', kick, T), keyframes('muzzle', muzzle, T), keyframes('marker', marker, T));
  css.push(
    keyframes('vig', [[0, 'opacity:0'], [vignette.in[0], 'opacity:0'], [vignette.in[1], 'opacity:1'], [vignette.out[0], 'opacity:1'], [vignette.out[1], 'opacity:0']], T),
    keyframes('banner', [[0, 'opacity:0'], [bannerIn, 'opacity:0'], [bannerIn + 0.3, 'opacity:1'], [tRespawn - 0.3, 'opacity:1'], [tRespawn, 'opacity:0']], T),
  );

  // Shared one-shot effects, started per target via animation-delay
  css.push(
    oneShot('tr', [[0, 'stroke-dashoffset:24;opacity:1'], [BULLET, 'stroke-dashoffset:-100;opacity:1'], [BULLET + 0.02, 'stroke-dashoffset:-100;opacity:0']], T),
    oneShot('fl', [[0, 'transform:scale(.2);opacity:1'], [0.35, 'transform:scale(2.4);opacity:0']], T),
    oneShot('sm', [[0, 'transform:translate(0px,0px) scale(.5);opacity:.45'], [1.3, 'transform:translate(4px,-12px) scale(2.3);opacity:0']], T),
    oneShot('cs', [
      [0, 'transform:translate(0px,0px) rotate(0deg);opacity:1'],
      [0.3, 'transform:translate(14px,-20px) rotate(320deg);opacity:1'],
      [0.8, 'transform:translate(26px,40px) rotate(760deg);opacity:0'],
    ], T),
  );
  const debrisDirs = [-150, -112, -74, -38, 12, 168].map((a, j) => {
    const rad = (a * Math.PI) / 180;
    const dist = 11 + (j % 3) * 4;
    return { dx: Math.cos(rad) * dist, dy: Math.sin(rad) * dist };
  });
  debrisDirs.forEach(({ dx, dy }, j) =>
    css.push(
      oneShot(`d${j}`, [
        [0, 'transform:translate(0px,0px) rotate(0deg);opacity:1'],
        [0.25, `transform:translate(${r2(dx * 0.7)}px,${r2(dy * 0.7 - 3)}px) rotate(140deg);opacity:1`],
        [0.75, `transform:translate(${r2(dx)}px,${r2(dy + 16)}px) rotate(300deg);opacity:0`],
      ], T),
    ),
  );

  // Per target: the crater layer and the hit counter
  shots.forEach((s, i) => {
    css.push(
      keyframes(`k${i}`, [[0, 'opacity:0'], [s.tHit, 'opacity:0'], [s.tHit + 0.03, 'opacity:1'], [tRespawn, 'opacity:1'], [tRespawn + 0.7, 'opacity:0']], T),
    );
  });
  for (let i = 0; i <= K; i++) {
    const from = i === 0 ? 0 : shots[i - 1].tHit;
    const to = i === K ? tRespawn : shots[i].tHit;
    const frames = i === 0
      ? [[0, 'opacity:1'], [to, 'opacity:0'], [tRespawn, 'opacity:1']]
      : [[0, 'opacity:0'], [from, 'opacity:1'], [to, 'opacity:0']];
    css.push(keyframes(`c${i}`, frames, T));
  }

  const anim = (sel, name, timing = 'linear') => `${sel}{animation:${name} ${r2(T)}s ${timing} infinite}`;
  const style = `
    text{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}
    .fx{transform-box:fill-box;transform-origin:center;opacity:0}
    #scope{transform:translate(${offscreen.x}px,${offscreen.y}px)}
    #aim{transform:rotate(${REST_ROT}deg)}
    ${anim('#scope', 'scope')} ${anim('#aim', 'aim')} ${anim('#kick', 'kick')}
    ${anim('#muzzle', 'muzzle')} ${anim('#marker', 'marker')} ${anim('#vig', 'vig')} ${anim('#banner', 'banner')}
    #sway{animation:sway 2.7s ease-in-out infinite}
    @keyframes sway{0%,100%{transform:translate(0px,0px)}25%{transform:translate(1.2px,-.9px)}50%{transform:translate(-.3px,1px)}75%{transform:translate(-1.1px,-.4px)}}
    .dead,#muzzle,#marker,#vig,#banner{opacity:0}
    .tr{fill:none;stroke-dasharray:24 400;animation:tr ${r2(T)}s linear infinite}
    .fl{animation:fl ${r2(T)}s ease-out infinite}
    .sm{animation:sm ${r2(T)}s ease-out infinite}
    .cs{animation:cs ${r2(T)}s linear infinite}
    ${debrisDirs.map((_, j) => `.d${j}{animation:d${j} ${r2(T)}s ease-out infinite}`).join('')}
    .cnt{opacity:0} #c0{opacity:1}
    ${shots.map((_, i) => `#k${i}{animation:k${i} ${r2(T)}s linear infinite}`).join('')}
    ${Array.from({ length: K + 1 }, (_, i) => `#c${i}{animation:c${i} ${r2(T)}s step-end infinite}`).join('')}
    @media (prefers-reduced-motion:reduce){*{animation:none!important}}
    ${css.join('\n')}`;

  // ---- static scene
  out.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${th.bg}" stroke="${th.border}"/>`);
  out.push(`<g clip-path="url(#panel)">`);

  // tactical corners
  const cs = 10;
  const corner = (x, y, sx, sy) => `<path d="M${x},${y + sy * cs}V${y}H${x + sx * cs}" fill="none" stroke="${th.accent}" stroke-width="1.5" opacity=".7"/>`;
  out.push(corner(12, 12, 1, 1), corner(W - 12, 12, -1, 1), corner(12, H - 12, 1, -1), corner(W - 12, H - 12, -1, -1));

  // HUD (drawn last, above the scope vignette)
  const hud = [];
  hud.push(
    `<text x="26" y="30" font-size="11.5">` +
      `<tspan fill="${th.accent}" font-weight="700" letter-spacing="1">◉ TARGET: @${esc(user)}</tspan>` +
      `<tspan dx="10" font-size="11" fill="${th.muted}">// ${total.toLocaleString('en-US')} contributions in the last year</tspan></text>`,
  );
  // the counter is a stack of texts, each one visible between two hits
  const cntX = W - 26;
  hud.push(`<text x="${cntX - 48}" y="30" font-size="11.5" text-anchor="end" fill="${th.muted}" letter-spacing="1">HITS</text>`);
  for (let i = 0; i <= K; i++) {
    hud.push(
      `<text id="c${i}" class="cnt" x="${cntX}" y="30" font-size="11.5" text-anchor="end" fill="${th.text}" font-weight="700" letter-spacing="1">${String(i).padStart(2, '0')}<tspan fill="${th.muted}" font-weight="400">/${String(K).padStart(2, '0')}</tspan></text>`,
    );
  }

  // month + weekday labels
  for (const { col, month } of monthMarks(cells, cols)) {
    out.push(`<text x="${GRID_X + col * STRIDE}" y="${GRID_Y - 8}" font-size="10" fill="${th.muted}">${MONTHS[month]}</text>`);
  }
  [['Mon', 1], ['Wed', 3], ['Fri', 5]].forEach(([d, row]) =>
    out.push(`<text x="${GRID_X - 8}" y="${GRID_Y + row * STRIDE + 9}" font-size="10" text-anchor="end" fill="${th.muted}">${d}</text>`),
  );

  // cells
  out.push('<g>');
  for (const c of cells) {
    out.push(`<rect x="${c.x}" y="${c.y}" width="${CELL}" height="${CELL}" rx="2" fill="${th.levels[c.level]}" stroke="${th.cellStroke}"/>`);
  }
  out.push('</g>');

  // legend + intel line
  const ly = gridBottom + 22;
  out.push(`<text x="${GRID_X}" y="${ly + 9}" font-size="10" fill="${th.muted}">Less</text>`);
  th.levels.forEach((color, i) =>
    out.push(`<rect x="${GRID_X + 32 + i * STRIDE}" y="${ly}" width="${CELL}" height="${CELL}" rx="2" fill="${color}" stroke="${th.cellStroke}"/>`),
  );
  out.push(`<text x="${GRID_X + 32 + 5 * STRIDE + 4}" y="${ly + 9}" font-size="10" fill="${th.muted}">More</text>`);
  out.push(
    `<text x="${GRID_X + 150}" y="${ly + 9}" font-size="10" fill="${th.muted}" letter-spacing=".5">INTEL ${updated} · WIND 2.4 m/s ◂ · ZERO 100 m</text>`,
  );

  // craters (hidden until hit)
  shots.forEach((s, i) => {
    const { x, y } = s.cell;
    const { x: cx, y: cy } = s.p;
    const rng = mulberry32(hash(`${s.cell.date}`));
    const cracks = Array.from({ length: 4 }, (_, j) => {
      const a = (j / 4) * Math.PI * 2 + rng() * 1.2;
      const len = 4 + rng() * 3;
      const mx = cx + Math.cos(a + 0.4) * len * 0.55;
      const my = cy + Math.sin(a + 0.4) * len * 0.55;
      return `M${r2(cx)},${r2(cy)}L${r2(mx)},${r2(my)}L${r2(cx + Math.cos(a) * len)},${r2(cy + Math.sin(a) * len)}`;
    }).join('');
    out.push(
      `<g id="k${i}" class="dead">` +
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${th.crater}"/>` +
        `<path d="${cracks}" fill="none" stroke="${th.hole}" stroke-width=".7" opacity=".8"/>` +
        `<circle cx="${cx}" cy="${cy}" r="3.3" fill="none" stroke="${th.ember}" stroke-width=".9" opacity=".75"/>` +
        `<circle cx="${cx}" cy="${cy}" r="2" fill="${th.hole}"/>` +
        `</g>`,
    );
  });

  // hit effects
  const tracers = [];
  const casings = [];
  shots.forEach((s) => {
    const { x: cx, y: cy } = s.p;
    const hitDelay = `animation-delay:${r2(s.tHit)}s`;
    out.push(`<circle class="fx sm" cx="${cx}" cy="${cy}" r="5" fill="${th.smoke}" style="${hitDelay}"/>`);
    debrisDirs.forEach((_, j) =>
      out.push(`<rect class="fx d${j}" x="${cx - 1.6}" y="${cy - 1.6}" width="3.2" height="3.2" fill="${th.levels[Math.max(1, s.cell.level)]}" style="${hitDelay}"/>`),
    );
    out.push(`<circle class="fx fl" cx="${cx}" cy="${cy}" r="7" fill="url(#boom)" style="${hitDelay}"/>`);
    tracers.push(
      `<path class="tr" d="M${r2(s.muzzle.x)},${r2(s.muzzle.y)}L${cx},${cy}" pathLength="100" stroke="${th.tracer}" stroke-width="1.6" stroke-linecap="round" style="animation-delay:${r2(s.tShot)}s;opacity:0"/>`,
    );
    casings.push(
      `<rect class="fx cs" x="${r2(s.port.x - 2.5)}" y="${r2(s.port.y - 1)}" width="5" height="2" rx=".8" fill="${th.brass}" style="animation-delay:${r2(s.tShot + 0.14)}s"/>`,
    );
  });

  // banner
  const bx = GRID_X + gridW / 2;
  const by = GRID_Y + 3.5 * STRIDE;
  hud.push(
    `<g id="banner">` +
      `<rect x="${bx - 190}" y="${by - 26}" width="380" height="52" rx="4" fill="${th.bannerBg}" fill-opacity=".9" stroke="${th.accent}"/>` +
      `<text x="${bx}" y="${by - 2}" font-size="17" font-weight="700" text-anchor="middle" fill="${th.accent}" letter-spacing="3">ACTIVITY NEUTRALIZED</text>` +
      `<text x="${bx}" y="${by + 16}" font-size="10.5" text-anchor="middle" fill="${th.muted}" letter-spacing="1">${K}/${K} targets down · respawning…</text>` +
      `</g>`,
  );

  // scope
  const R = SCOPE_R;
  const dots = [-24, -16, -8, 8, 16, 24];
  out.push(
    `<g id="scope"><g id="sway">` +
      `<circle id="vig" r="${R + 900}" fill="none" stroke="${th.vignette}" stroke-opacity="${th.vignetteOpacity}" stroke-width="1800"/>` +
      `<circle r="${R}" fill="url(#lens)"/>` +
      `<circle r="${R + 1.5}" fill="none" stroke="${th.ring}" stroke-width="4"/>` +
      `<circle r="${R - 1.5}" fill="none" stroke="${th.accent}" stroke-opacity=".35"/>` +
      // duplex posts
      `<path d="M${-R},0H${-R * 0.48}M${R * 0.48},0H${R}M0,${-R}V${-R * 0.48}M0,${R * 0.48}V${R}" stroke="${th.post}" stroke-width="3" opacity=".85"/>` +
      `<path d="M${-R * 0.48},0H-3M3,0H${R * 0.48}M0,${-R * 0.48}V-3M0,3V${R * 0.48}" stroke="${th.accent}" stroke-width=".8"/>` +
      dots.map((d) => `<circle cx="${d}" r=".9" fill="${th.accent}"/><circle cy="${d}" r=".9" fill="${th.accent}"/>`).join('') +
      `<circle r="3.2" fill="${th.accent}" opacity=".25"/><circle r="1.3" fill="${th.accent}"/>` +
      `<path d="M${-R * 0.72},${-R * 0.42}A${R * 0.84},${R * 0.84} 0 0 1 ${-R * 0.2},${-R * 0.8}" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="2.5" stroke-linecap="round"/>` +
      `<g id="marker" stroke="${th.text}" stroke-width="1.4" stroke-linecap="round"><path d="M-9,-9L-5,-5M9,-9L5,-5M-9,9L-5,5M9,9L5,5"/></g>` +
      `</g></g>`,
  );
  out.push(...tracers);

  // rifle
  out.push(
    `<g transform="translate(${pivot.x},${pivot.y}) scale(${RIFLE_SCALE})"><g id="aim"><g id="kick">${rifle(th)}` +
      `<g id="muzzle"><path d="M-188,-1.5L-204,-9L-199,-2L-216,-0.5L-199,1.5L-205,8Z" fill="url(#mflash)"/><circle cx="-193" cy="-1" r="6" fill="#fff6d5" opacity=".9"/></g>` +
      `</g></g></g>`,
  );

  out.push(...casings, ...hud);
  out.push('</g>'); // clip

  const defs = `<defs>
    <clipPath id="panel"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10"/></clipPath>
    <radialGradient id="boom"><stop offset="0" stop-color="#fffbe6"/><stop offset=".35" stop-color="#ffd27a"/><stop offset=".7" stop-color="${th.ember}" stop-opacity=".6"/><stop offset="1" stop-color="${th.ember}" stop-opacity="0"/></radialGradient>
    <radialGradient id="mflash"><stop offset="0" stop-color="#fffbe6"/><stop offset=".5" stop-color="#ffd27a"/><stop offset="1" stop-color="#ff7b3d"/></radialGradient>
    <radialGradient id="lens"><stop offset=".6" stop-color="${th.accent}" stop-opacity="0"/><stop offset="1" stop-color="${th.vignette}" stop-opacity=".35"/></radialGradient>
  </defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="A sniper scope shooting down @${esc(user)}'s GitHub contribution graph">
<title>@${esc(user)} · activity range</title>
<style>${style.replace(/\n\s*/g, '')}</style>
${defs}
${out.join('\n')}
</svg>
`;
}

function rifle(th) {
  const body = `fill="${th.gun}" stroke="${th.gunEdge}" stroke-width="1"`;
  const dark = `fill="${th.gunDark}" stroke="${th.gunEdge}" stroke-width=".8"`;
  return [
    `<path d="M-150,1L-116,9" stroke="${th.gunDark}" stroke-width="2.6" stroke-linecap="round"/>`,
    `<path d="M8,-6L62,-9L80,-4L80,13L67,15L40,6L14,6Z" ${body}/>`,
    `<path d="M26,-8L58,-11L61,-8L28,-5Z" fill="${th.gunDark}"/>`,
    `<rect x="-176" y="-4" width="118" height="5" ${dark}/>`,
    `<rect x="-188" y="-5.5" width="13" height="8" rx="1" ${body}/>`,
    `<rect x="-112" y="-6.5" width="52" height="11" rx="2" ${body}/>`,
    `<rect x="-62" y="-7" width="72" height="12" rx="2" ${body}/>`,
    `<path d="M-30,5L-16,5L-14,19L-28,19Z" ${dark}/>`,
    `<path d="M-8,5Q-6,14 4,14L8,5" fill="none" stroke="${th.gunEdge}" stroke-width="1.5"/>`,
    `<path d="M6,4L17,4L23,23L12,25Z" ${body}/>`,
    `<rect x="-50" y="-12" width="6" height="6" fill="${th.gunDark}"/><rect x="-14" y="-12" width="6" height="6" fill="${th.gunDark}"/>`,
    `<path d="M-66,-24L-54,-21H-4L6,-23V-13L-4,-15H-54L-66,-12Z" ${dark}/>`,
    `<rect x="-67" y="-23" width="2" height="10" fill="${th.accent}" opacity=".85"/>`,
    `<path d="M-2,-6L3,-12" stroke="${th.gunEdge}" stroke-width="2"/><circle cx="4" cy="-13" r="2.4" fill="${th.gunEdge}"/>`,
  ].join('');
}

// ------------------------------------------------------------------ main ---
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const rng = mulberry32(hash(`${USER}:${today}`));
  const data = await loadData(rng);
  const cells = toGrid(data.days);
  const cols = Math.max(...cells.map((c) => c.col)) + 1;
  const W = GRID_X + cols * STRIDE - GAP + RIFLE_ZONE;
  const targets = pickTargets(cells, rng, { x: W, y: GRID_Y + 3 * STRIDE });
  const timeline = buildTimeline(targets, W);

  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, theme] of Object.entries(THEMES)) {
    const svg = renderSvg({ cells, timeline, total: data.total, user: USER, theme, updated: today });
    await writeFile(join(OUT_DIR, `sniper-${name}.svg`), svg);
  }
  const json = { user: USER, total: data.total, updated: today, source: data.source, days: data.days };
  await writeFile(join(OUT_DIR, 'contributions.json'), JSON.stringify(json));

  console.log(
    `✓ @${USER}: ${data.total} contributions (${data.source}), ${targets.length} targets, loop ${timeline.T.toFixed(1)}s -> ${OUT_DIR}/`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
