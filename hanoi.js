'use strict';

/* ==========================================================================
 * Flight thread
 *
 * This function is the entire body of a Web Worker. Every ring flight runs in
 * its own worker (a real OS thread). It is serialized with toString() into a
 * Blob URL so the site works from any static host *and* when index.html is
 * opened straight from disk (file://), where separate worker files are blocked.
 *
 * The thread never touches the screen. It flies its route only as far as Air
 * Traffic Control has cleared it, reporting its position as it goes. When it
 * reaches the end of its clearance it hovers until ATC extends it.
 * ========================================================================== */
function flightThread() {
  let path, total, speed, paused;
  let s = 0, limit = 0;

  // The non-blocking descendant of Java's Thread.sleep().
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // The route is a list of axis-aligned points; s is the distance flown along it.
  function pointAt(d) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (d <= len || i === path.length - 1) {
        const t = len ? Math.min(1, d / len) : 1;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      d -= len;
    }
  }

  async function fly() {
    let last = performance.now(), stalled = 0, holding = false;
    while (s < total) {
      await sleep(16);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (paused) continue;
      if (s < limit) {
        s = Math.min(limit, s + speed * dt);
        postMessage({ type: 'pos', s, ...pointAt(s) });
        stalled = 0;
        if (holding) { holding = false; postMessage({ type: 'resume' }); }
      } else if (s > 0 && !holding && (stalled += dt) > 0.15) {
        holding = true;
        postMessage({ type: 'hold' });
      }
    }
    postMessage({ type: 'landed' });
  }

  onmessage = e => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        ({ path, speed, paused } = m);
        total = path.slice(1).reduce((sum, b, i) => sum + Math.abs(b.x - path[i].x) + Math.abs(b.y - path[i].y), 0);
        fly();
        break;
      case 'clearance': limit = Math.max(limit, m.limit); break;
      case 'speed': speed = m.speed; break;
      case 'pause': paused = m.paused; break;
    }
  };
}

const workerURL = URL.createObjectURL(
  new Blob(['(' + flightThread.toString() + ')();'], { type: 'text/javascript' })
);

/* ==========================================================================
 * Main thread: solver, dispatcher, Air Traffic Control and renderer.
 * ========================================================================== */
const W = 960, H = 540;
const BASE_Y = 492;
const TOWER_X = [160, 480, 800];
const MIN_W = 60, MAX_W = 250;
const LABELS = ['A', 'B', 'C'];
const MAX_THREADS = 6;
const EPS = 1e-6;
const LOG_LINES = 7;

const $ = id => document.getElementById(id);
const canvas = $('sky');
const ctx = canvas.getContext('2d');
const ringSelect = $('rings'), speedInput = $('speed'), startBtn = $('start'), resetBtn = $('reset');

let sim;

// The classic recursive solution. It produces the move list; threads fly it.
function solve(n, from, to, via, moves) {
  if (n === 0) return moves;
  solve(n - 1, from, via, to, moves);
  moves.push({ ring: n, from, to });
  solve(n - 1, via, to, from, moves);
  return moves;
}

function geometry(n) {
  const ringH = Math.min(30, 260 / n);
  const towerTop = BASE_Y - n * ringH - 24;
  return {
    X: TOWER_X, ringH, towerTop, cruiseY: Math.max(110, towerTop - 3 * ringH),
    // Minimum clearance between rings. Slightly more than the space between two
    // stacked rings, so a ring can't lift off while another is landing on it.
    gap: ringH * 0.2,
  };
}

const groundY = (g, i) => BASE_Y - (i + 0.5) * g.ringH;

function newSim(n) {
  if (sim) for (const f of sim.flights.values()) f.worker.terminate();
  const g = geometry(n);
  const rings = [];
  for (let r = 1; r <= n; r++) {
    const t = (r - 1) / Math.max(1, n - 1);
    rings[r] = { r, w: MIN_W + (MAX_W - MIN_W) * t, color: `hsl(${Math.round(190 + t * 170) % 360} 80% 62%)`,
      x: 0, y: 0, air: false, holding: false };
  }
  const stacks = [[], [], []];
  for (let r = n; r >= 1; r--) stacks[0].push(r);
  stacks[0].forEach((r, i) => Object.assign(rings[r], { x: TOWER_X[0], y: groundY(g, i) }));

  // Replay the solution once to give every move its exact route, takeoff
  // height and landing height.
  const moves = solve(n, 0, 2, 1, []);
  const replay = stacks.map(st => [...st]);
  for (const m of moves) {
    const startY = groundY(g, replay[m.from].length - 1);
    replay[m.to].push(replay[m.from].pop());
    const landY = groundY(g, replay[m.to].length - 1);
    m.path = [
      { x: TOWER_X[m.from], y: startY }, { x: TOWER_X[m.from], y: g.cruiseY },
      { x: TOWER_X[m.to], y: g.cruiseY }, { x: TOWER_X[m.to], y: landY },
    ];
  }

  sim = {
    n, geo: g, rings, moves, stacks, flights: new Map(),
    next: 0, landed: 0, peak: 0, holds: 0,
    running: false, paused: false, done: false, elapsed: 0,
  };
  $('atc-log').innerHTML = '';
  log(`Tower: ${n} rings on Tower A, ${moves.length} moves planned. Ready.`);
  startBtn.textContent = 'Start';
}

/* ---------------------------- Air Traffic Control ---------------------------
 * Every flight owns the airspace along the rest of its route: from where the
 * ring is now to where it will land. A flight may never enter airspace owned
 * by an earlier move (lower move number). ATC clears each flight as far along
 * its own route as it can go before it would come within g.gap pixels of that
 * airspace. Earlier moves are therefore never blocked by later ones, so the
 * earliest unfinished move can always fly, and there is no deadlock.
 * -------------------------------------------------------------------------- */

const segLen = (a, b) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// The airspace a flight still needs: one rectangle per remaining leg of its route.
function remainingRoute(f) {
  const rects = [], path = f.move.path;
  let d0 = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], d1 = d0 + segLen(a, b);
    if (f.s < d1) {
      const p = f.s > d0 ? lerp(a, b, (f.s - d0) / (d1 - d0)) : a;
      rects.push({ x1: Math.min(p.x, b.x), x2: Math.max(p.x, b.x), y1: Math.min(p.y, b.y), y2: Math.max(p.y, b.y) });
    }
    d0 = d1;
  }
  if (!rects.length) { const p = path[path.length - 1]; rects.push({ x1: p.x, x2: p.x, y1: p.y, y2: p.y }); }
  return rects;
}

// How far a ring's centre can travel from A towards B before entering obstacle o.
function contact(a, b, o) {
  const horizontal = a.y === b.y;
  const [along, across, alongB] = horizontal ? ['x', 'y', b.x] : ['y', 'x', b.y];
  const lo = o[along + '1'], hi = o[along + '2'];
  if (!(a[across] > o[across + '1'] + EPS && a[across] < o[across + '2'] - EPS)) return Infinity;
  if (a[along] > lo + EPS && a[along] < hi - EPS) return 0;
  if (alongB > a[along]) return lo >= a[along] - EPS && lo < alongB ? Math.max(0, lo - a[along]) : Infinity;
  return hi <= a[along] + EPS && hi > alongB ? Math.max(0, a[along] - hi) : Infinity;
}

function clearanceFor(s, f) {
  // A ring can't lift off until it is the top ring on its tower.
  if (!f.airborne && s.stacks[f.move.from].at(-1) !== f.move.ring) return { limit: 0, by: null };
  const hw = s.rings[f.move.ring].w / 2, hh = f.hh, gap = s.geo.gap;
  const obstacles = [];
  for (const e of s.flights.values()) {
    if (e.k >= f.k) break;
    const ew = s.rings[e.move.ring].w / 2;
    for (const r of remainingRoute(e)) {
      obstacles.push({ k: e.k, x1: r.x1 - ew - hw - gap, x2: r.x2 + ew + hw + gap,
        y1: r.y1 - e.hh - hh - gap, y2: r.y2 + e.hh + hh + gap });
    }
  }
  const path = f.move.path;
  let d0 = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], d1 = d0 + segLen(a, b);
    if (f.s < d1) {
      const start = Math.max(f.s, d0), from = lerp(a, b, (start - d0) / (d1 - d0));
      let best = Infinity, by = null;
      for (const o of obstacles) {
        const d = contact(from, b, o);
        if (d < best) { best = d; by = o.k; }
      }
      if (best !== Infinity) return { limit: start + best, by };
    }
    d0 = d1;
  }
  return { limit: d0, by: null };
}

function updateClearances(s) {
  for (const f of s.flights.values()) {
    const { limit, by } = clearanceFor(s, f);
    f.blockedBy = by;
    if (limit > f.sentLimit + 0.01) {
      f.sentLimit = limit;
      f.worker.postMessage({ type: 'clearance', limit });
    }
  }
}

function whereIs(ring) {
  const t = TOWER_X.findIndex(x => Math.abs(ring.x - x) < 40);
  if (t >= 0) return `over Tower ${LABELS[t]}`;
  const i = ring.x < TOWER_X[1] ? 0 : 1;
  return `between Towers ${LABELS[i]} and ${LABELS[i + 1]}`;
}

/* -------------------------------- Dispatcher -------------------------------- */

function dispatch(s) {
  while (s.next < s.moves.length && s.flights.size < MAX_THREADS) spawn(s, s.next++);
  updateClearances(s);
}

function spawn(s, k) {
  const move = s.moves[k], ring = s.rings[move.ring];
  const worker = new Worker(workerURL);
  const f = { k, move, worker, s: 0, hh: s.geo.ringH * 0.41, sentLimit: -1, airborne: false, blockedBy: null };
  s.flights.set(k, f);
  worker.onmessage = e => {
    if (s !== sim) return;
    const m = e.data;
    switch (m.type) {
      case 'pos':
        if (!f.airborne) {
          f.airborne = true;
          s.stacks[move.from].pop();
          ring.air = true;
          s.peak = Math.max(s.peak, s.rings.filter(r => r && r.air).length);
        }
        f.s = m.s; ring.x = m.x; ring.y = m.y;
        updateClearances(s);
        break;
      case 'hold': {
        ring.holding = true;
        s.holds++;
        const by = f.blockedBy !== null ? `Ring ${s.moves[f.blockedBy].ring} has the airspace ahead` : 'awaiting clearance';
        log(`Ring ${move.ring} holding ${whereIs(ring)}: ${by}.`, 'hold');
        break;
      }
      case 'resume':
        ring.holding = false;
        log(`Ring ${move.ring} cleared to continue to Tower ${LABELS[move.to]}.`, 'clear');
        break;
      case 'landed':
        ring.air = false;
        ring.holding = false;
        s.stacks[move.to].push(move.ring);
        worker.terminate();
        s.flights.delete(k);
        s.landed++;
        if (s.landed === s.moves.length) finish(s); else dispatch(s);
        break;
    }
  };
  worker.postMessage({ type: 'init', path: move.path, speed: +speedInput.value, paused: s.paused });
}

function finish(s) {
  s.done = true;
  startBtn.textContent = 'Run again';
  log(`Solved: ${s.moves.length} moves in ${(s.elapsed / 1000).toFixed(1)} s, peak ${s.peak} rings airborne, ${s.holds} ATC holds.`, 'clear');
}

const broadcast = msg => { for (const f of sim.flights.values()) f.worker.postMessage(msg); };

function log(text, kind = '') {
  const list = $('atc-log');
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = text;
  list.prepend(li);
  while (list.children.length > LOG_LINES) list.lastChild.remove();
}

/* --------------------------------- Renderer --------------------------------- */

function drawRing(ring, g, now) {
  const h = g.ringH * 0.82, x = ring.x, y = ring.y;
  ctx.beginPath();
  ctx.roundRect(x - ring.w / 2, y - h / 2, ring.w, h, h / 2);
  ctx.fillStyle = ring.color;
  ctx.fill();
  if (ring.holding) {
    const pulse = 0.55 + 0.45 * Math.sin(now / 140);
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(251, 191, 36, ${pulse})`;
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.font = '600 12px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('HOLD', x, y - h / 2 - 6);
  }
  ctx.fillStyle = '#0b1220';
  ctx.font = `600 ${Math.round(h * 0.6)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ring.r, x, y + 1);
  ctx.textBaseline = 'alphabetic';
}

let lastFrame = performance.now();

function frame(now) {
  const s = sim, g = s.geo;
  if (s.running && !s.paused && !s.done) s.elapsed += now - lastFrame;
  lastFrame = now;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Cruise lane.
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  ctx.beginPath();
  ctx.moveTo(30, g.cruiseY);
  ctx.lineTo(W - 30, g.cruiseY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('CRUISE LANE', 30, g.cruiseY - g.ringH * 0.5 - 8);

  // Towers.
  ctx.fillStyle = '#334155';
  ctx.beginPath();
  ctx.roundRect(30, BASE_Y, W - 60, 14, 4);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.font = '600 16px system-ui, sans-serif';
  TOWER_X.forEach((x, i) => {
    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.roundRect(x - 5, g.towerTop, 10, BASE_Y - g.towerTop, 4);
    ctx.fill();
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`Tower ${LABELS[i]}`, x, BASE_Y + 36);
  });

  // Rings on the ground, then rings in the air.
  s.stacks.forEach((stack, t) => stack.forEach((r, i) => Object.assign(s.rings[r], { x: TOWER_X[t], y: groundY(g, i) })));
  for (const ring of s.rings) if (ring && !ring.air) drawRing(ring, g, now);
  for (const ring of s.rings) if (ring && ring.air) drawRing(ring, g, now);

  $('stat-moves').textContent = `${s.landed} / ${s.moves.length}`;
  $('stat-air').textContent = s.rings.filter(r => r && r.air).length;
  $('stat-peak').textContent = s.peak;
  $('stat-threads').textContent = s.flights.size;
  $('stat-holds').textContent = s.holds;
  $('stat-time').textContent = (s.elapsed / 1000).toFixed(1) + ' s';

  requestAnimationFrame(frame);
}

/* --------------------------------- Controls --------------------------------- */

for (let n = 3; n <= 10; n++) ringSelect.add(new Option(`${n} rings`, n, n === 5, n === 5));

ringSelect.addEventListener('change', () => newSim(+ringSelect.value));
resetBtn.addEventListener('click', () => newSim(+ringSelect.value));
speedInput.addEventListener('input', () => broadcast({ type: 'speed', speed: +speedInput.value }));

startBtn.addEventListener('click', () => {
  if (sim.done) newSim(+ringSelect.value);
  if (!sim.running) {
    sim.running = true;
    startBtn.textContent = 'Pause';
    dispatch(sim);
  } else {
    sim.paused = !sim.paused;
    startBtn.textContent = sim.paused ? 'Resume' : 'Pause';
    broadcast({ type: 'pause', paused: sim.paused });
  }
});

// Read-only hook used by the automated browser check.
Object.defineProperty(window, 'hanoiDebug', { get: () => sim });

newSim(+ringSelect.value);
requestAnimationFrame(frame);
