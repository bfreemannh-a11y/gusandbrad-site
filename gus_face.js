/* Gus MK-II scope face — neon-green trace with a personality.
   Everything Gus's voice plays routes through Scope.sink(), so the trace IS
   his voice. Cues from the brain ([face:...], [bit:...], [show:...], [hide])
   land in Scope.cue(). Plain JS, no frameworks (house rule). */

const Scope = (() => {
  // ── audio plumbing: master gain -> analyser -> speakers ──────────────────
  let actx = null, master = null, analyser = null, wave = null;

  function sink(audioCtx) {
    if (!master || actx !== audioCtx) {
      actx = audioCtx;
      master = actx.createGain();
      master.gain.value = volume;
      analyser = actx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      wave = new Float32Array(analyser.fftSize);
      master.connect(analyser);
      analyser.connect(actx.destination);
    }
    return master;
  }

  // ── state ────────────────────────────────────────────────────────────────
  let canvas, ctx, W = 0, H = 0, R = 0;
  let volume = 1.0, glow = 14;
  let focusK = 0.7, sweepK = 1; // FOCUS = trace crispness, HORIZ = trace speed
  let powered = false, powerT = 0;           // CRT warm-up / collapse animation
  let mood = "neutral", moodUntil = 0;       // smile | frown | neutral
  let eyeAnim = null, eyeT0 = 0;             // blink | wink | roll | left | right
  let nextAutoBlink = performance.now() + 4000;
  let bit = null, bitT0 = 0, bitDur = 0;     // running comedy bit
  let noSignalUntil = 0;

  const PHOS = "#4dff85", PHOS_SOFT = "rgba(120,255,150,0.10)";

  // ── canvas setup ─────────────────────────────────────────────────────────
  function init() {
    canvas = document.getElementById("scope");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(2, r.width * devicePixelRatio);
      canvas.height = Math.max(2, r.height * devicePixelRatio);
      W = canvas.width; H = canvas.height; R = Math.min(W, H) * 0.5 * 0.86;
    };
    new ResizeObserver(fit).observe(canvas);
    fit();
    initKnobs();
    // decorative toggles still deserve a satisfying flip (the MIC and
    // LOCAL/REMOTE switches are real — the page wires those itself)
    document.querySelectorAll(
      ".toggle:not(#micToggle):not(#lineToggle):not(#lampToggle):not(#calToggle)"
    ).forEach(el => el.addEventListener("click", () => el.classList.toggle("on")));
    // face-catalog preview: open http://localhost:5178/?faces to cycle every
    // expression on a dead scope (no mic, no brain) — for tuning the look
    if (new URLSearchParams(location.search).has("faces")) {
      power(true);
      const names = Object.keys(EXPR);
      let i = 0;
      const label = document.getElementById("status");
      setInterval(() => {
        mood = names[i % names.length];
        moodUntil = performance.now() + 60000;
        if (label) label.textContent = "face: " + mood;
        i++;
      }, 2200);
    }
    requestAnimationFrame(draw);
  }

  // ── the draw loop ────────────────────────────────────────────────────────
  function draw(t) {
    requestAnimationFrame(draw);
    if (!ctx || W < 4) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const g = ctx.createRadialGradient(W / 2, H / 2, R * 0.1, W / 2, H / 2, R * 1.2);
    g.addColorStop(0, "#0a2113"); g.addColorStop(1, "#04120a");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    ctx.translate(W / 2, H / 2);
    graticule();

    // CRT power animation: dot -> line -> picture (and the reverse at close)
    const pt = Math.min(1, (t - powerT) / 450);
    if (!powered && pt >= 1) return;
    if (pt < 1) {
      const k = powered ? pt : 1 - pt;
      ctx.save();
      ctx.strokeStyle = PHOS; ctx.shadowColor = PHOS; ctx.shadowBlur = glow * 2;
      ctx.lineWidth = Math.max(2, R * 0.02);
      ctx.beginPath();
      ctx.moveTo(-R * k, 0); ctx.lineTo(R * k, 0);
      ctx.stroke(); ctx.restore();
      if (k < 0.995) return;
    }

    ctx.strokeStyle = PHOS; ctx.fillStyle = PHOS;
    // FOCUS knob: crisp thin beam at full, fat fuzzy halo when defocused
    ctx.shadowColor = PHOS; ctx.shadowBlur = glow * (1.7 - focusK);
    ctx.lineWidth = Math.max(2, R * 0.016 * (1.9 - focusK));
    ctx.lineCap = "round"; ctx.lineJoin = "round";

    if (t > noSignalUntil - 1200 && t < noSignalUntil) { drawNoSignal(t); return; }
    if (bit === "taps") drawTaps(t);

    // idle show: a quiet MINUTE and the trace goes wandering; his voice
    // (or any cue) snaps him straight back to his face. A thinking Gus is
    // NOT an idle Gus — the screensaver reading as "he didn't hear me" is
    // exactly what Brad flagged (2026-08-16).
    if (thinkOn) { lastVoiceAt = t; idle.on = false; }
    if (getRMS() > 0.012) { lastVoiceAt = t; idle.on = false; }
    if (!idle.on && powered && !bit && t - lastVoiceAt > IDLE_AFTER) {
      idle.on = true; pickIdleFx(t);
    }
    if (idle.on) {
      if (t > idle.until) pickIdleFx(t);
      drawIdle(t);
      return;
    }

    if (mood !== "neutral" && t > moodUntil) mood = "neutral";
    if (!eyeAnim && t > nextAutoBlink) { eyeAnim = "blink"; eyeT0 = t; }
    drawGear(t);
    drawFace(t);
  }

  // ── the idle show: screensaver bits in pure trace ────────────────────────
  // Brad's call, 2026-08-19: ten seconds was quick enough that a normal
  // bench pause put him into the screensaver mid-conversation. One minute.
  const IDLE_AFTER = 60000;
  let lastVoiceAt = 0, listenUntil = 0;
  const idle = { on: false, fx: null, t0: 0, until: 0, dir: 1, seed: 1, stars: null };
  const IDLE_FX = ["radar", "cube", "figure8", "yawn", "compass", "clock",
                   "shuffle", "ekg", "donut", "globe", "starfield", "tunnel",
                   "helix"];

  // Brad's mic (VAD in the page) pokes this — the face comes back, attentive
  function hearBrad() {
    const now = performance.now();
    if (now > listenUntil) listenAt = now; // fresh speech = fresh thinking beat
    lastVoiceAt = now;
    idle.on = false;
    listenUntil = now + 1600;
  }

  // THINKING (Brad's spec 2026-08-16): while the brain is genuinely working
  // and no voice is out, the face must SAY so — gear spins up, eyes go up and
  // hold, and the idle show can never start. "He goes silent at times when I
  // am not sure if he is thinking or didn't hear me" — this is the answer.
  let thinkOn = false;
  function thinking(on) {
    thinkOn = !!on;
    if (thinkOn) idle.on = false;
  }

  // a clang, a shout — the double-take: eyes dart away, snap back wide,
  // pupils shrink. Rare on purpose (comedy dies on repetition).
  function startle() {
    const now = performance.now();
    if (now - lastStartle < 10000) return;
    lastStartle = now;
    startleT0 = now; startleUntil = now + 850;
    lastVoiceAt = now; idle.on = false;
  }

  // tiny 3D projector: rotate about X then Y, then perspective
  function proj(x, y, z, rx, ry, scale) {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const y2 = y * cx - z * sx, z2 = y * sx + z * cx;
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const x3 = x * cy + z2 * sy, z3 = -x * sy + z2 * cy;
    const k = 3.2 / (3.2 + z3);
    return [x3 * k * scale, y2 * k * scale, k];
  }

  function line3(a, b, rx, ry, s) {
    const p1 = proj(a[0], a[1], a[2], rx, ry, s);
    const p2 = proj(b[0], b[1], b[2], rx, ry, s);
    ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
  }

  function loop3(pts, rx, ry, s, close = true) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const q = proj(p[0], p[1], p[2], rx, ry, s);
      i === 0 ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1]);
    });
    if (close) ctx.closePath();
    ctx.stroke();
  }

  function circle3(fn, steps, rx, ry, s) { // fn(u) -> [x,y,z]
    const pts = [];
    for (let i = 0; i < steps; i++) pts.push(fn((i / steps) * Math.PI * 2));
    loop3(pts, rx, ry, s);
  }

  let idleDeck = []; // shuffled deck: every bit plays once before any repeat
  function pickIdleFx(t) {
    if (!idleDeck.length) {
      idleDeck = IDLE_FX.slice();
      for (let i = idleDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idleDeck[i], idleDeck[j]] = [idleDeck[j], idleDeck[i]];
      }
      // fresh deck must not open with the bit we just watched
      if (idleDeck[idleDeck.length - 1] === idle.fx && idleDeck.length > 1)
        idleDeck.unshift(idleDeck.pop());
    }
    idle.fx = idleDeck.pop(); idle.t0 = t;
    idle.until = t + 5000 + Math.random() * 5000;   // 5-10s each, randomized
    idle.dir = Math.random() < 0.4 ? -1 : 1;        // clock can run backwards
    idle.seed = Math.random() * 1000;
    idle.stars = null;                              // fresh starfield each visit
  }

  function drawIdle(t) {
    const p = ((t - idle.t0) / 1000) * sweepK; // HORIZ knob paces the idle show
    const fx = idle.fx;
    if (fx === "radar") {
      const a = p * 1.5;
      for (let i = 0; i < 26; i++) {           // fading sweep trail
        const ang = a - i * 0.05;
        ctx.globalAlpha = (1 - i / 26) * 0.55;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(ang) * R * 0.92, Math.sin(ang) * R * 0.92);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (let b = 0; b < 4; b++) {            // contact blips light as the beam passes
        const ba = idle.seed * (b + 1) % (Math.PI * 2), br = R * (0.3 + 0.16 * b);
        const behind = ((a - ba) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        ctx.globalAlpha = Math.max(0, 1 - behind * 0.55);
        ctx.beginPath();
        ctx.arc(Math.cos(ba) * br, Math.sin(ba) * br, R * 0.022, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (fx === "cube") {
      const rx = p * 0.8, ry = p * 1.25, s = R * 0.42;
      const v = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1])
        v.push([x, y, z]);
      const E = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],
                 [4,5],[4,6],[5,7],[6,7]];
      for (const [a, b] of E) line3(v[a], v[b], rx, ry, s);
    } else if (fx === "donut") {
      const rx = 0.9 + p * 0.7, ry = p * 1.1, s = R * 0.42;
      const R0 = 1, r0 = 0.45;
      for (let j = 0; j < 12; j++) {            // rings around the tube
        const a = (j / 12) * Math.PI * 2;
        circle3(u => [(R0 + r0 * Math.cos(u)) * Math.cos(a), r0 * Math.sin(u),
                      (R0 + r0 * Math.cos(u)) * Math.sin(a)], 20, rx, ry, s);
      }
      for (const u of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) { // hoops the long way
        circle3(a => [(R0 + r0 * Math.cos(u)) * Math.cos(a), r0 * Math.sin(u),
                      (R0 + r0 * Math.cos(u)) * Math.sin(a)], 32, rx, ry, s);
      }
    } else if (fx === "globe") {
      const rx = 0.35, ry = p * 0.9, s = R * 0.62;
      for (let m = 0; m < 6; m++) {             // meridians pole to pole
        const a = (m / 6) * Math.PI;
        circle3(u => [Math.sin(u) * Math.cos(a), Math.cos(u),
                      Math.sin(u) * Math.sin(a)], 32, rx, ry, s);
      }
      for (const th of [0.35, 0.15, -0.15, -0.35]) { // latitude rings
        const y = Math.sin(th * Math.PI), r = Math.cos(th * Math.PI);
        circle3(a => [r * Math.cos(a), y, r * Math.sin(a)], 32, rx, ry, s);
      }
    } else if (fx === "starfield") {
      if (!idle.stars) {
        idle.stars = [];
        for (let i = 0; i < 70; i++)
          idle.stars.push({ x: (Math.random() - 0.5) * 2.4,
                            y: (Math.random() - 0.5) * 2.4,
                            z0: Math.random() * 3 });
      }
      for (const st of idle.stars) {
        const z = ((st.z0 - p * 0.6) % 3 + 3) % 3 + 0.12; // fly forever forward
        const k1 = 1 / z, k2 = 1 / (z + 0.10);
        ctx.globalAlpha = Math.min(1, Math.max(0.05, 1.4 - z * 0.45));
        ctx.beginPath();
        ctx.moveTo(st.x * k2 * R * 0.5, st.y * k2 * R * 0.5);
        ctx.lineTo(st.x * k1 * R * 0.5, st.y * k1 * R * 0.5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (fx === "tunnel") {
      for (let i = 1; i <= 13; i++) {
        const f = i + (p * 3) % 1;
        const r = R * 0.045 * Math.pow(1.33, f);
        const drift = f / 13;                    // near rings wander, far stay centered
        const cx2 = R * 0.10 * Math.sin(p * 1.1) * drift;
        const cy2 = R * 0.08 * Math.cos(p * 1.5) * drift;
        ctx.globalAlpha = Math.min(0.95, f / 9);
        ctx.beginPath(); ctx.arc(cx2, cy2, Math.min(r, R * 0.95), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (fx === "helix") {
      const rx = 0.3, ry = p * 1.2, s = R * 0.55;
      for (const ph of [0, Math.PI]) {          // the two strands
        const pts = [];
        for (let y = -1.15; y <= 1.15; y += 0.06)
          pts.push([0.45 * Math.cos(4 * y + p * 2 + ph), y,
                    0.45 * Math.sin(4 * y + p * 2 + ph)]);
        loop3(pts, rx, ry, s, false);
      }
      for (let y = -1.05; y <= 1.05; y += 0.30) { // the rungs
        const a = 4 * y + p * 2;
        line3([0.45 * Math.cos(a), y, 0.45 * Math.sin(a)],
              [0.45 * Math.cos(a + Math.PI), y, 0.45 * Math.sin(a + Math.PI)],
              rx, ry, s);
      }
    } else if (fx === "figure8") {
      ctx.globalAlpha = 0.22;                   // ghost of the whole path
      traceLissajous(0, Math.PI * 2, 120);
      ctx.globalAlpha = 1;
      const head = p * 2.1;                     // bright comet head
      traceLissajous(head - 0.9, head, 40);
    } else if (fx === "yawn") {
      drawBrows([0.25, 0.03, 0.5]);
      drawEyes(t, "closedsleepy");
      const ph = (p % 4.5) / 4.5;               // slow build, big stretch, settle
      const o = Math.pow(Math.sin(Math.PI * ph), 1.6);
      ctx.beginPath();
      ctx.ellipse(0, R * 0.34, R * (0.05 + 0.16 * o), R * (0.05 + 0.24 * o),
                  0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (fx === "compass") {
      ctx.beginPath(); ctx.arc(0, 0, R * 0.72, 0, Math.PI * 2); ctx.stroke();
      ctx.font = `bold ${Math.round(R * 0.13)}px Impact, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const pts = [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0]];
      for (const [ch, dx, dy] of pts) ctx.fillText(ch, dx * R * 0.58, dy * R * 0.58);
      for (let a = 0; a < 360; a += 30) {
        const r1 = R * 0.66, r2 = R * 0.72, rad = a * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(Math.cos(rad) * r1, Math.sin(rad) * r1);
        ctx.lineTo(Math.cos(rad) * r2, Math.sin(rad) * r2);
        ctx.stroke();
      }
      // needle spins hard, then settles on north with a nervous wobble
      const ang = -Math.PI / 2 + p * 9 * Math.exp(-p * 0.9)
                + 0.12 * Math.sin(p * 5) * Math.exp(-p * 0.25);
      for (const [flip, len, alpha] of [[1, 0.5, 1], [-1, 0.4, 0.4]]) {
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(ang) * R * len * flip, Math.sin(ang) * R * len * flip);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(0, 0, R * 0.035, 0, Math.PI * 2); ctx.fill();
    } else if (fx === "clock") {
      ctx.beginPath(); ctx.arc(0, 0, R * 0.72, 0, Math.PI * 2); ctx.stroke();
      for (let h = 0; h < 12; h++) {
        const rad = h * Math.PI / 6, r1 = R * (h % 3 === 0 ? 0.60 : 0.65);
        ctx.beginPath();
        ctx.moveTo(Math.cos(rad) * r1, Math.sin(rad) * r1);
        ctx.lineTo(Math.cos(rad) * R * 0.72, Math.sin(rad) * R * 0.72);
        ctx.stroke();
      }
      const base = -Math.PI / 2, d = idle.dir;   // hands fly — sometimes backwards
      for (const [speed, len, wide] of [[d * 0.6, 0.34, 3], [d * 4.5, 0.52, 2],
                                        [d * 14, 0.6, 1]]) {
        ctx.save();
        ctx.lineWidth = Math.max(1.5, R * 0.012 * wide);
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(base + p * speed) * R * len,
                   Math.sin(base + p * speed) * R * len);
        ctx.stroke(); ctx.restore();
      }
      ctx.beginPath(); ctx.arc(0, 0, R * 0.03, 0, Math.PI * 2); ctx.fill();
    } else if (fx === "shuffle") {
      const ground = R * 0.55;
      ctx.globalAlpha = 0.4;
      ctx.beginPath(); ctx.moveTo(-R * 0.8, ground); ctx.lineTo(R * 0.8, ground);
      ctx.stroke(); ctx.globalAlpha = 1;
      const cx = R * 0.28 * Math.sin(p * 1.2);        // the side-to-side slide
      const bob = R * 0.02 * Math.sin(p * 12);
      const hipY = R * 0.12 + bob, shY = -R * 0.16 + bob, headY = -R * 0.34 + bob;
      ctx.beginPath(); ctx.arc(cx, headY, R * 0.095, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, headY + R * 0.095); ctx.lineTo(cx, hipY);
      ctx.stroke();
      for (const s of [-1, 1]) {                       // arms swing opposite legs
        const sw = Math.sin(p * 6 + (s > 0 ? 0 : Math.PI));
        const ex = cx + s * R * 0.16 + sw * R * 0.07;
        const ey = shY + R * 0.14 - Math.abs(sw) * R * 0.05;
        ctx.beginPath(); ctx.moveTo(cx, shY);
        ctx.quadraticCurveTo(cx + s * R * 0.14, shY + R * 0.04, ex, ey);
        ctx.stroke();
        const step = Math.sin(p * 6 + (s > 0 ? Math.PI : 0));
        const fx2 = cx + s * R * 0.09 + step * R * 0.13;
        const lift = Math.max(0, step) * R * 0.06;     // shuffling feet skim the floor
        ctx.beginPath(); ctx.moveTo(cx, hipY);
        ctx.quadraticCurveTo(cx + s * R * 0.1, hipY + R * 0.2, fx2, ground - lift);
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(fx2, ground - lift);
        ctx.lineTo(fx2 + s * R * 0.07, ground - lift); ctx.stroke();
      }
    } else if (fx === "ekg") {
      const sweep = ((p * 0.45) % 1) * 2 * R * 0.92 - R * 0.92;
      ctx.beginPath();
      for (let x = -R * 0.92; x <= R * 0.92; x += 3) {
        const dist = sweep - x;
        if (dist < 0) break;
        ctx.globalAlpha = Math.max(0.06, 1 - dist / (R * 1.1));
        const y = -ekgShape(((x + R * 0.92) / R) * 1.4 % 1.4) * R;
        x === -R * 0.92 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  }

  function traceLissajous(u0, u1, steps) {
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const u = u0 + (u1 - u0) * (i / steps);
      const x = R * 0.62 * Math.sin(u), y = R * 0.38 * Math.sin(2 * u);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function ekgShape(u) { // one heartbeat: flat, P bump, QRS spike, T bump
    if (u < 0.35) return 0.02 * Math.sin(u * 30);
    if (u < 0.45) return 0.05 * Math.sin((u - 0.35) * 31);
    if (u < 0.50) return -0.06;
    if (u < 0.56) return 0.42 * Math.sin((u - 0.50) * 52);
    if (u < 0.62) return -0.1 * (1 - (u - 0.56) / 0.06);
    if (u < 0.85) return 0.09 * Math.sin((u - 0.62) * 13.6);
    return 0;
  }

  // ── the gear ring (TRIAL, Brad 2026-08-01) ───────────────────────────────
  // A machinist's gear rides around his face. It never spins for show: it
  // holds still, or creeps forward, or creeps back, and picks which at
  // random every few seconds — so it reads as a machine idling, not an
  // animation. Same tooth shape as the channel avatar.
  const gear = { mode: "still", until: 0, ang: 0, spd: 0 };
  let gearLast = 0;
  function pickGearMode(t) {
    const modes = ["still", "still", "fwd", "rev"];   // stillness is the default mood
    gear.mode = modes[Math.floor(Math.random() * modes.length)];
    gear.until = t + 5000 + Math.random() * 12000;
    gear.spd = gear.mode === "still" ? 0
             : (gear.mode === "fwd" ? 1 : -1) * (0.00003 + Math.random() * 0.00006);
  }
  function drawGear(t) {
    if (t > gear.until) pickGearMode(t);
    const dt = gearLast ? Math.min(64, t - gearLast) : 16;
    gearLast = t;
    // thinking = the machine is actually turning: the gear spins visibly
    // faster than its idle creep (Brad's spec 2026-08-16 — "spin his gear
    // faster"), and drops back to the lazy creep the moment he speaks
    gear.ang += (thinkOn ? 0.00045 : gear.spd) * dt;
    const rRoot = R * 0.98, rTip = R * 1.12, n = 12, step = Math.PI * 2 / n;
    const wr = step * 0.30, wt = step * 0.155;
    const P = (r, g) => [Math.cos(g) * r, Math.sin(g) * r];
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = i * step - Math.PI / 2 + gear.ang;
      const [ax, ay] = P(rRoot, a - wr);
      i === 0 ? ctx.moveTo(ax, ay) : ctx.lineTo(ax, ay);
      ctx.lineTo(...P(rTip, a - wt));
      ctx.lineTo(...P(rTip, a + wt));
      ctx.lineTo(...P(rRoot, a + wr));
      ctx.arc(0, 0, rRoot, a + wr, a + step - wr);
    }
    ctx.closePath();
    ctx.stroke();
  }

  function graticule() {
    // modern bench-scope grid: 10x8 divisions + finer ticks on the center axes
    // (was round radar rings — retired with the WWII face, 2026-07-25)
    ctx.save();
    ctx.strokeStyle = PHOS_SOFT; ctx.lineWidth = 1; ctx.shadowBlur = 0;
    const hw = W / 2, hh = H / 2;
    ctx.beginPath();
    for (let i = 1; i < 10; i++) { const x = -hw + (W * i) / 10; ctx.moveTo(x, -hh); ctx.lineTo(x, hh); }
    for (let i = 1; i < 8; i++)  { const y = -hh + (H * i) / 8;  ctx.moveTo(-hw, y); ctx.lineTo(hw, y); }
    ctx.stroke();
    ctx.beginPath(); // brighter center crosshair with minor ticks
    ctx.moveTo(-hw, 0); ctx.lineTo(hw, 0); ctx.moveTo(0, -hh); ctx.lineTo(0, hh);
    const tick = Math.min(W, H) * 0.008;
    for (let i = 1; i < 50; i++) { const x = -hw + (W * i) / 50; ctx.moveTo(x, -tick); ctx.lineTo(x, tick); }
    for (let i = 1; i < 40; i++) { const y = -hh + (H * i) / 40; ctx.moveTo(-tick, y); ctx.lineTo(tick, y); }
    ctx.stroke();
    ctx.restore();
  }

  // ── his face: expression vocabulary from Brad's cartoon sheet ────────────
  // brow: [innerTilt (+ = inner ends up: worried; - = inner ends down: angry),
  //        raise, arch] · eye: how the eyes sit · mouth: [type, param]
  // eye: [style, openness (lid 1=normal), pupil size mult, look x, look y]
  // mouth: the trace, always — ["wave", bend] at different smile/frown levels;
  // ["open", size] (the oval) ONLY where the expression truly calls for it
  const EXPR = {
    neutral:   { brow: [0, 0, .5],       eye: ["open", 1, 1, 0, 0],        mouth: ["wave", .35] }, /* resting face keeps a hint of smile (Brad, 7/23) */
    smile:     { brow: [0, .03, .6],     eye: ["open", .9, 1, 0, 0],       mouth: ["wave", 1] },
    frown:     { brow: [.25, 0, .4],     eye: ["open", .9, .9, 0, 0],      mouth: ["wave", -1] },
    happy:     { brow: [0, .05, .7],     eye: ["open", .8, 1.05, 0, 0],    mouth: ["wave", 1.8] },
    laugh:     { brow: [0, .07, .7],     eye: ["closedhappy", 1, 1, 0, 0], mouth: ["open", 1.25] },
    grin:      { brow: [0, .04, .6],     eye: ["crossed", 1, 1, 0, 0],     mouth: ["wave", 1.5] },
    angry:     { brow: [-.6, -.02, .25], eye: ["open", .65, .8, 0, 0],     mouth: ["wave", -.9] },
    furious:   { brow: [-.8, -.05, .15], eye: ["open", .5, .7, 0, 0],      mouth: ["wave", -1.8] },
    worried:   { brow: [.55, .07, .6],   eye: ["open", 1.3, .9, 0, -.2],   mouth: ["wave", -.6] },
    sad:       { brow: [.5, 0, .5],      eye: ["open", .85, .95, 0, .4],   mouth: ["wave", -1.5] },
    skeptical: { brow: [-.2, 0, .3],     eye: ["half", 1, 1, .15, 0],      mouth: ["wave", -.4] },
    sleepy:    { brow: [.1, .02, .5],    eye: ["closedsleepy", 1, 1, 0, 0],mouth: ["wave", -.15] },
    grimace:   { brow: [.35, .06, .6],   eye: ["open", 1.25, .8, 0, 0],    mouth: ["wave", -1.1] },
    silly:     { brow: [0, .05, .7],     eye: ["side", 1, 1.1, 0, 0],      mouth: ["wave", 1.4] },
    huh:       { brow: [.25, .02, .4],   eye: ["halfup", 1, .9, 0, 0],     mouth: ["wave", -.5] },
    surprised: { brow: [.2, .12, .8],    eye: ["open", 1.45, .65, 0, 0],   mouth: ["open", .55] },
  };

  function getRMS() {
    if (!analyser || !actx || actx.state !== "running") return 0;
    analyser.getFloatTimeDomainData(wave);
    let s = 0;
    for (let i = 0; i < 128; i++) { const v = wave[i * 4] || 0; s += v * v; }
    return Math.sqrt(s / 128);
  }

  // smooth transitions: brows glide, eye changes hide inside a blink, and the
  // mouth collapses to the trace line then redraws as the new shape (very CRT)
  let browCur = [0, 0, 0.5];
  let eyeStyleCur = "open", eyeStyleTarget = null;
  const mouthCur = { type: "wave", k: 0, f: 1 };

  // eased eye state so everything glides: openness, pupil size, gaze,
  // plus little darting glances (saccades) so the eyes never sit dead still
  const eyeCur = { open: 1, pupil: 1, lx: 0, ly: 0 };
  const sacc = { x: 0, y: 0, tx: 0, ty: 0, next: 0, pend: null };
  // charm pass (Brad's go, 7/23): flesh, thought, imperfection
  let envSm = 0;                     // smoothed voice envelope — drives the jaw
  let listenAt = 0, listenLevel = 0; // perk-with-a-beat when Brad speaks
  let browAsym = { l: 1, r: 1 }, asymMood = null; // one brow a little off, per mood
  let moodRamp = 0.15;               // mouth ease; [face: warm] slows it right down
  let startleUntil = 0, startleT0 = 0, lastStartle = 0;

  function drawFace(t) {
    const e = EXPR[mood] || EXPR.neutral;
    // micro-life: the face breathes (~3.7s cycle) and never sits dead still —
    // perfect stillness is the number-one "it's a computer" tell
    const bx = (Math.sin(t / 2000) + 0.7 * Math.cos(t / 3300)) * R * 0.004;
    const by = Math.sin(t / 590) * R * 0.006 + Math.sin(t / 2700) * R * 0.0025;
    ctx.save();
    ctx.translate(bx, by);

    // Brad's talking: a thinking beat first (~100ms), THEN the quick perk —
    // instant reactions read as sensors, delayed ones read as thought
    const listening = mood === "neutral" && t < listenUntil && t > listenAt + 100;
    listenLevel += ((listening ? 1 : 0) - listenLevel) * 0.35;
    if (mood !== asymMood) { // one brow always rides a little off (imperfection)
      asymMood = mood;
      browAsym = Math.random() < 0.5 ? { l: 0.82 + Math.random() * 0.3, r: 1 }
                                     : { l: 1, r: 0.82 + Math.random() * 0.3 };
    }
    const browTgt = [e.brow[0] + 0.06 * listenLevel,
                     e.brow[1] + 0.09 * listenLevel,
                     e.brow[2] + 0.25 * listenLevel];
    for (let i = 0; i < 3; i++) browCur[i] += (browTgt[i] - browCur[i]) * 0.14;
    drawBrows(browCur);

    const [style, open, pupil, lx, ly] = e.eye;
    eyeCur.open  += ((open + 0.15 * listenLevel) - eyeCur.open) * 0.12;
    eyeCur.pupil += (pupil - eyeCur.pupil) * 0.12;
    // thinking: eyes drift UP and hold there — the universal "give me a
    // second, I'm working on it" face (Brad's spec 2026-08-16). Saccades
    // pause so the gaze reads held, not wandering.
    eyeCur.lx    += ((thinkOn ? 0 : lx) - eyeCur.lx) * 0.1;
    eyeCur.ly    += ((thinkOn ? -0.6 : ly) - eyeCur.ly) * 0.1;
    if (thinkOn) {
      sacc.tx = sacc.ty = 0; sacc.pend = null;
      sacc.next = t + 1200; // fresh glance soon after the thought lands
    }
    if (t > sacc.next) { // glance somewhere new — with a hair of anticipation
      const ntx = Math.random() < 0.35 ? 0 : (Math.random() - 0.5) * 0.5;
      const nty = Math.random() < 0.35 ? 0 : (Math.random() - 0.5) * 0.3;
      sacc.pend = { tx: ntx, ty: nty, at: t + 55 };
      sacc.tx = sacc.x - (ntx - sacc.x) * 0.12; // a hair the WRONG way first
      sacc.ty = sacc.y - (nty - sacc.y) * 0.12;
      sacc.next = t + 1800 + Math.random() * 3800;
    }
    if (sacc.pend && t > sacc.pend.at) {
      sacc.tx = sacc.pend.tx; sacc.ty = sacc.pend.ty; sacc.pend = null;
    }
    sacc.x += (sacc.tx - sacc.x) * 0.22; // then the dart snaps, settles soft
    sacc.y += (sacc.ty - sacc.y) * 0.22;

    if (style !== eyeStyleCur && !eyeStyleTarget) {
      eyeStyleTarget = style;
      if (!eyeAnim) { eyeAnim = "blink"; eyeT0 = t; }
    }
    drawEyes(t, eyeStyleCur);

    const tgt = e.mouth;
    if (tgt[0] !== mouthCur.type) {
      mouthCur.f = Math.max(0, mouthCur.f - 0.12);      // shrink to the line...
      if (mouthCur.f === 0) { mouthCur.type = tgt[0]; mouthCur.k = tgt[1] || 0; }
    } else {
      mouthCur.f = Math.min(1, mouthCur.f + 0.12);      // ...grow back as the new one
      mouthCur.k += ((tgt[1] || 0) - mouthCur.k) * moodRamp;
    }
    moodRamp += (0.15 - moodRamp) * 0.01; // a warm slow smile drifts back to normal speed
    const y0 = R * 0.34;
    ctx.save();
    ctx.translate(0, y0); ctx.scale(1, Math.max(0.02, mouthCur.f)); ctx.translate(0, -y0);
    drawMouthFor(t, [mouthCur.type, mouthCur.k]);
    ctx.restore();
    ctx.restore();
  }

  function drawBrows([tilt, raise, arch]) {
    const ex = R * 0.34, el = R * 0.17;
    for (const s of [-1, 1]) {
      const m = s < 0 ? browAsym.l : browAsym.r; // symmetry is the enemy of charm
      const browY = -R * 0.52 - raise * m * R;
      const innerX = s * (ex - el), outerX = s * (ex + el);
      const innerY = browY - tilt * m * R * 0.14, outerY = browY + tilt * m * R * 0.07;
      ctx.beginPath();
      ctx.moveTo(innerX, innerY);
      ctx.quadraticCurveTo(s * ex, browY - arch * m * R * 0.12, outerX, outerY);
      ctx.stroke();
    }
  }

  function drawEyes(t, style) {
    const ex = R * 0.34, ey = -R * 0.26, rx = R * 0.115;
    let ry = R * 0.15 * eyeCur.open;             // widen / squint with the mood
    let lid = 1, dt = t - eyeT0, pupilMul = 1;
    // gaze = expression bias + wandering glance
    let px = (eyeCur.lx + sacc.x) * rx * 0.55;
    let py = (eyeCur.ly + sacc.y) * R * 0.15 * 0.5;
    if (eyeAnim === "blink" || eyeAnim === "wink") {
      // flesh, not shutters: slam shut fast (40ms), open slow (150ms) with a
      // little bounce past full-open before settling
      if (dt < 40) lid = 1 - dt / 40;
      else if (dt < 190) {
        const q = (dt - 40) / 150 - 1;
        lid = 1 + q * q * (2.70158 * q + 1.70158); // eases out past 100%, settles
      } else lid = 1;
      if (dt >= 40 && eyeStyleTarget) { // swap styles while the lids are down
        eyeStyleCur = eyeStyleTarget; eyeStyleTarget = null; style = eyeStyleCur;
      }
      if (dt > 190) { eyeAnim = null; nextAutoBlink = t + 3500 + Math.random() * 5500; }
    } else if (eyeAnim === "roll") {
      const p = Math.min(1, dt / 900);
      const a = -Math.PI / 2 + p * Math.PI * 2;
      px = Math.cos(a) * rx * 0.5; py = Math.sin(a) * ry * 0.4 - ry * 0.1;
      if (dt > 1050) eyeAnim = null;
    } else if (eyeAnim === "left" || eyeAnim === "right") {
      const dir = eyeAnim === "left" ? -1 : 1;
      px = dir * rx * 0.55 * Math.min(1, dt / 200);
      if (dt > 1500) eyeAnim = null;
    }
    if (t < startleUntil) { // the double-take, mid-flight
      const sd = t - startleT0;
      px = sd < 260 ? rx * 0.6 : 0;   // dart away... snap back
      ry *= sd < 260 ? 0.92 : 1.28;   // ...over-wide
      pupilMul = 0.55;                // pupils pin small
    }
    if (style === "halfup") py = -ry * 0.35;
    if (style === "side") px = rx * 0.5;
    // the happy squint: a smile pushes the cheeks up into the bottom of the
    // eyes — the one smile muscle you can't fake. Talking loud joins in too,
    // proving mouth and eyes share the same face.
    const cheek = Math.min(1, Math.max(0, mouthCur.k) * 0.5 +
                              (mouthCur.k > -0.2 ? envSm * 0.3 : 0));
    const bot = ry * (1 - 0.8 * cheek);

    for (const s of [-1, 1]) {
      const cx = s * ex;
      // closed styles win unless a blink is animating
      if ((style === "closedhappy" || style === "closedsleepy") && !eyeAnim) {
        const up = style === "closedhappy" ? -1 : 1; // happy bulges up, sleepy sags
        ctx.beginPath();
        ctx.moveTo(cx - rx, ey);
        ctx.quadraticCurveTo(cx, ey + up * ry * 0.9, cx + rx, ey);
        ctx.stroke();
        for (const lx of [-0.6, 0, 0.6]) { // lashes
          const bx = cx + lx * rx, by = ey + up * ry * (0.8 - Math.abs(lx) * 0.45);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + lx * rx * 0.2, by + up * ry * 0.35);
          ctx.stroke();
        }
        continue;
      }
      const shut = (eyeAnim === "wink" && s === 1) || eyeAnim === "blink" ? lid : 1;
      if (shut < 0.15) { // mid-blink: a line
        ctx.beginPath(); ctx.moveTo(cx - rx, ey); ctx.lineTo(cx + rx, ey); ctx.stroke();
        continue;
      }
      ctx.save();
      ctx.translate(cx, ey);
      // closing lids drag the flesh a touch wider — squash and stretch
      ctx.scale(1 + 0.13 * Math.max(0, 1 - shut), shut);
      if (style === "half" || style === "halfup") {
        // heavy lids: lower half of the eye + a flat lid line
        ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-rx, 0); ctx.lineTo(rx, 0); ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, Math.max(py, ry * 0.3), rx * 0.32 * eyeCur.pupil, 0, Math.PI * 2);
        ctx.fill();
      } else {
        let ppx = px, ppy = py;
        if (style === "crossed") { ppx = -s * rx * 0.35; ppy = s * ry * 0.15; } // goofy
        // squircle, not ellipse: flat-ish top, and a bottom edge the cheeks
        // can push up into a crescent (ellipses can't show cheeks — that's
        // why they read dead)
        ctx.beginPath();
        ctx.moveTo(-rx, 0);
        ctx.bezierCurveTo(-rx * 0.98, -ry, rx * 0.98, -ry, rx, 0);
        ctx.bezierCurveTo(rx * (0.98 - 0.3 * cheek), bot,
                          -rx * (0.98 - 0.3 * cheek), bot, -rx, 0);
        ctx.closePath(); ctx.stroke();
        ctx.beginPath();
        ctx.arc(ppx, Math.min(ppy, bot * 0.35),
                rx * 0.32 * eyeCur.pupil * pupilMul, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // the mouth is ALWAYS the signal trace (bent by mood level), except the
  // open oval where an expression truly calls for it (Brad's rule, 7/18)
  function drawMouthFor(t, [type, k]) {
    const y0 = R * 0.34;
    // phone-call lip gate (Brad, 2026-07-27): while a FRIEND is the one
    // talking, Gus's mouth holds still — he listens with his eyes instead
    const lipsStill = window.GusLips && window.GusLips.still();
    if (type === "open") {
      const rms = lipsStill ? 0 : Math.min(1, getRMS() * 6); // breathes with his voice
      const rx = R * 0.26 * k, ry = R * 0.20 * k * (0.8 + rms * 0.45);
      ctx.beginPath(); ctx.ellipse(0, y0, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    drawMouthWave(t, k, y0, lipsStill);
  }

  // the two-lip waveform mouth (Brad's idea, consult-confirmed 7/23): a
  // smoothed volume envelope opens the JAW in the middle (corners stay
  // pinned — that's what reads as talking), while each lip still ripples
  // with the live waveform, kept small so it's a mouth with energy in it,
  // not a music visualizer. Silent = the lips settle into one calm trace.
  function drawMouthWave(t, curve, y0, lipsStill) {
    const w = R * 1.15, amp = R * 0.30;
    let data = null;
    if (!lipsStill && analyser && actx && actx.state === "running") {
      analyser.getFloatTimeDomainData(wave);
      data = wave;
    }
    // gated: the jaw eases shut instead of following a friend's voice
    envSm += ((lipsStill ? 0 : Math.min(1, getRMS() * 5.5)) - envSm) * 0.25;
    const jaw = envSm * R * 0.15;
    const N = 96;
    const lips = jaw > R * 0.006 ? [-1, 1] : [0]; // quiet = single calm trace
    for (const up of lips) {
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const fx = i / N;
        const x = -w / 2 + fx * w;
        // smile bows the center down (canvas y grows downward), frown up
        const bend = curve * R * 0.13 * (1 - Math.pow(2 * fx - 1, 2));
        const win = Math.sin(fx * Math.PI); // corners pinned, center opens
        let v = 0;
        if (data) {
          v = data[Math.floor(fx * (data.length - 1))] * amp * (up === 0 ? 2.2 : 0.6);
          v = Math.max(-amp, Math.min(amp, v));
        }
        if (!data || (up === 0 && Math.abs(v) < 0.004 * R)) {
          // idle hum so the trace always feels alive (HORIZ sets the pace)
          v = Math.sin(fx * 18 + t * sweepK / 300) * R * 0.006 +
              Math.sin(fx * 5 - t * sweepK / 700) * R * 0.004;
        }
        const y = up === 0 ? y0 + bend + v
                           : y0 + bend + up * jaw * win - up * v;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // ── comedy bits ──────────────────────────────────────────────────────────
  function drawNoSignal(t) {
    ctx.save();
    ctx.font = `bold ${Math.round(R * 0.18)}px Impact, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.globalAlpha = 0.25 + 0.15 * Math.sin(t / 60);
    ctx.fillText("NO SIGNAL", 0, 0);
    const y = ((t / 3) % (R * 2)) - R; // rolling static band
    ctx.globalAlpha = 0.10; ctx.fillRect(-R, y, R * 2, R * 0.12);
    ctx.restore();
  }

  function drawTaps(t) {
    const dt = t - bitT0;
    if (dt > bitDur) { bit = null; return; }
    ctx.save();
    // flagpole, flag at half mast, gentle ripple
    const px0 = -R * 0.72, top = -R * 0.55, bot = R * 0.55;
    ctx.beginPath(); ctx.moveTo(px0, bot); ctx.lineTo(px0, top); ctx.stroke();
    ctx.beginPath(); ctx.arc(px0, top, R * 0.02, 0, Math.PI * 2); ctx.fill();
    const fy = -R * 0.18, fw = R * 0.42, fh = R * 0.24; // half-mast
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const fx = i / 24, x = px0 + fx * fw;
      const ripple = Math.sin(fx * 5 - t / 180) * R * 0.02 * fx;
      i === 0 ? ctx.moveTo(x, fy + ripple) : ctx.lineTo(x, fy + ripple);
    }
    for (let i = 24; i >= 0; i--) {
      const fx = i / 24, x = px0 + fx * fw;
      const ripple = Math.sin(fx * 5 - t / 180) * R * 0.02 * fx;
      ctx.lineTo(x, fy + fh + ripple);
    }
    ctx.closePath(); ctx.stroke();
    // drifting notes
    for (let n = 0; n < 3; n++) {
      const p = ((dt / 1000 + n * 1.3) % 4) / 4;
      const nx = R * 0.35 + n * R * 0.12, ny = R * 0.25 - p * R * 0.9;
      ctx.globalAlpha = 1 - p;
      ctx.beginPath(); ctx.arc(nx, ny, R * 0.028, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(nx + R * 0.028, ny);
      ctx.lineTo(nx + R * 0.028, ny - R * 0.09); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.font = `bold ${Math.round(R * 0.09)}px Impact, sans-serif`;
    ctx.textAlign = "center"; ctx.globalAlpha = 0.3;
    ctx.fillText("TAPS", 0, R * 0.72);
    ctx.restore();
  }

  // bugle synth — Taps, first three calls (public domain since 1862)
  function playTaps() {
    if (!actx) return 0;
    const seq = [ // [midi-ish freq, beats]
      [196.0, .7], [196.0, .3], [261.6, 1.8],
      [196.0, .7], [261.6, .3], [329.6, 1.8],
      [261.6, .7], [329.6, .3], [392.0, 2.6],
    ];
    const beat = 0.62;
    let t = actx.currentTime + 0.15;
    const start = t;
    for (const [f, b] of seq) {
      const dur = b * beat;
      const osc = actx.createOscillator(); osc.type = "sawtooth";
      osc.frequency.value = f;
      const vib = actx.createOscillator(); vib.frequency.value = 5.5;
      const vibGain = actx.createGain(); vibGain.gain.value = 3.5;
      vib.connect(vibGain); vibGain.connect(osc.detune);
      const lp = actx.createBiquadFilter(); lp.type = "lowpass";
      lp.frequency.value = 1400; lp.Q.value = 1.2;
      const env = actx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
      env.gain.setValueAtTime(0.5, t + dur - 0.12);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.2);
      osc.connect(lp); lp.connect(env); env.connect(master);
      osc.start(t); vib.start(t);
      osc.stop(t + dur + 0.25); vib.stop(t + dur + 0.25);
      t += dur;
    }
    return (t - start) * 1000 + 600;
  }

  function playWomp() { // sad trombone: womp womp womp wommmp
    if (!actx) return 0;
    const steps = [[233, .4], [220, .4], [208, .4], [185, 1.5]];
    let t = actx.currentTime + 0.1;
    const start = t;
    for (let i = 0; i < steps.length; i++) {
      const [f, dur] = steps[i];
      const osc = actx.createOscillator(); osc.type = "square";
      osc.frequency.setValueAtTime(f * 1.06, t);
      osc.frequency.exponentialRampToValueAtTime(f, t + dur * 0.8);
      if (i === steps.length - 1) { // the dying wobble
        const wob = actx.createOscillator(); wob.frequency.value = 6;
        const wg = actx.createGain(); wg.gain.value = 12;
        wob.connect(wg); wg.connect(osc.detune);
        wob.start(t); wob.stop(t + dur);
      }
      const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 900;
      const env = actx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.35, t + 0.04);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(lp); lp.connect(env); env.connect(master);
      osc.start(t); osc.stop(t + dur + 0.1);
      t += dur + 0.08;
    }
    return (t - start) * 1000 + 300;
  }

  async function playBitFile(name) { // Brad drops clips in rig/bits/, Gus names them
    try {
      const resp = await fetch("/bits/" + encodeURIComponent(name));
      if (!resp.ok) throw 0;
      const buf = await actx.decodeAudioData(await resp.arrayBuffer());
      const src = actx.createBufferSource();
      src.buffer = buf; src.connect(master); src.start();
      return buf.duration * 1000;
    } catch (e) { noSignalUntil = performance.now() + 1400; return 0; }
  }

  // ── the viewer: what Gus puts up on the big screen ───────────────────────
  // Sites that send X-Frame-Options/frame-ancestors and would render a dead
  // grey box inside the viewer. These get an honest card + an OPEN button
  // instead. (Add to this list when a new store shows up blank on camera.)
  const NO_EMBED = new RegExp("(^|\\.)(amazon\\.|ebay\\.|walmart\\.|homedepot\\.|" +
    "lowes\\.|newegg\\.|aliexpress\\.|banggood\\.|digikey\\.|mouser\\.|" +
    "facebook\\.|instagram\\.|reddit\\.|x\\.com|twitter\\.|craigslist\\.|" +
    "google\\.com/search)", "i");

  function openOut(url) {  // hand it to Brad's real browser (a tab, not a popup)
    fetch("/open", { method: "POST",
                     headers: { "Content-Type": "application/json" },
                     body: JSON.stringify({ url }) }).catch(() => {});
  }

  // The viewer bar's way out to a real browser. One button, created once,
  // shown only while a real web page is framed (an image, a local doc, a
  // search grid or a video has nothing to escape to).
  function setViewerOut(url) {
    const bar = document.getElementById("viewerBar");
    if (!bar) return;
    let out = document.getElementById("viewerOut");
    if (!url) { if (out) out.hidden = true; return; }
    if (!out) {
      out = document.createElement("button");
      out.id = "viewerOut";
      out.textContent = "OPEN IN BROWSER";
      out.title = "links inside the glass can't open — this hands the real "
                + "site to your browser";
      bar.insertBefore(out, document.getElementById("viewerClose"));
    }
    out.hidden = false;
    out.onclick = () => openOut(url);
  }

  function linkCard(url) {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}
    const card = document.createElement("div");
    card.className = "link-card";
    const h = document.createElement("div");
    h.className = "link-card-host";
    h.textContent = host;
    const p = document.createElement("div");
    p.className = "link-card-path";
    p.textContent = url.replace(/^https?:\/\/(www\.)?/, "");
    const b = document.createElement("button");
    b.className = "link-card-btn";
    b.textContent = "OPEN IN BROWSER";
    b.onclick = () => openOut(url);
    card.append(h, p, b);
    return card;
  }

  function missingCard(labelText) {
    // a local file that isn't there gets an honest card, never a browser
    // 404 inside the frame — Brad saw two of those on camera 2026-07-27
    const card = document.createElement("div");
    card.className = "link-card";
    const h = document.createElement("div");
    h.className = "link-card-host";
    h.textContent = "NOT ON THE SHELF";
    const p = document.createElement("div");
    p.className = "link-card-path";
    p.textContent = labelText;
    card.append(h, p);
    return card;
  }

  // The video yields to Gus (Brad's spec 2026-07-30): when Gus takes the
  // screen back, a playing YouTube clip PAUSES in place and waits invisibly.
  // The iframe never leaves the DOM (re-appending an iframe reloads it and
  // loses the spot) — park() just hides the viewer; showing the same video
  // again unhides it and presses play, resuming where it paused.
  const YTID_RE =
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/;
  let ytLive = null, ytParked = null, hideTimer = null, ytWaiter = null;

  function ytCmd(func) {
    const f = document.querySelector("#viewerContent iframe");
    if (f && f.contentWindow) f.contentWindow.postMessage(
      JSON.stringify({ event: "command", func, args: [] }), "*");
  }

  // Gus says his piece BEFORE the video plays (Brad, 2026-07-30: "he talks
  // over the video"). Videos load paused; this waits for his voice (and the
  // rest of the turn) to finish, then presses play — twice, a beat apart,
  // because a just-loaded player can swallow the first command.
  function playWhenGusDone() {
    if (ytWaiter) clearInterval(ytWaiter);
    let fired = 0;
    ytWaiter = setInterval(() => {
      const busy = window.GusVoiceBusy ? GusVoiceBusy() : false;
      if (busy) return;
      ytCmd("playVideo");
      if (++fired >= 2) {
        clearInterval(ytWaiter); ytWaiter = null;
        wlogScope("video play (Gus finished his piece)");
      }
    }, 300);
  }

  function cancelYtWaiter() {
    if (ytWaiter) { clearInterval(ytWaiter); ytWaiter = null; }
  }

  function wlogScope(ev) {  // window black box (see index.html wlog)
    try { fetch("/wlog", { method: "POST", keepalive: true,
      body: JSON.stringify({ ev: ev }) }).catch(() => {}); } catch (e) {}
  }

  function park() {
    wlogScope("park (page hidden)");
    hide();   // hide() itself keeps a video's spot now — see below
  }

  function show(args) {
    const tokens = args.trim().split(/\s+/);
    const opts = {};
    while (tokens.length > 1
           && /^(page|fx)=|^full$/i.test(tokens[tokens.length - 1])) {
      const tok = tokens.pop();
      // [show: X full] — the page takes the WHOLE frame, bezel and knobs
      // gone, same stage a presentation uses (Brad, 08-19: a schematic that
      // only fills the glass is not full screen)
      if (/^full$/i.test(tok)) { opts.full = true; continue; }
      const [k, v] = tok.split("=");
      opts[k] = v;
    }
    let target = tokens.join(" ");
    if (!target) return;
    // a trailing #N is the money jump (open on stage N) — lift it into the
    // page= machinery BEFORE path-building, or encodeURIComponent bakes the
    // "#" into the filename and the card 404s into the missing-card frame
    // (query allowed: block.html?b=led&vin=9#3 still jumps — round seven)
    const jumpM = target.match(/^(.*\.html(?:\?[^#]*)?)#(\d+)$/i);
    if (jumpM) { target = jumpM[1]; if (!opts.page) opts.page = jumpM[2]; }
    const viewer = document.getElementById("viewer");
    const content = document.getElementById("viewerContent");
    const caption = document.getElementById("viewerCaption");
    // a show landing inside hide's 320ms close animation must not have the
    // stale timer slam the viewer shut (or wipe a resuming video) under it
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    viewer.classList.remove("closing");
    // the same video asked for again = resume from the parked spot
    const ytm = target.match(YTID_RE);
    if (ytm && ytParked === ytm[1] && content.querySelector("iframe")) {
      wlogScope("resume video " + ytm[1]);
      ytParked = null;
      playWhenGusDone();  // resumes AFTER Gus finishes announcing it
      caption.textContent = target.replace(/^https?:\/\//, "");
      viewer.className = "fx-" + (opts.fx === "fade" ? "fade" : "iris");
      viewer.classList.remove("hidden");
      requestAnimationFrame(() => requestAnimationFrame(() => viewer.classList.add("open")));
      document.body.classList.add("viewing");
      return;
    }
    if (ytLive || ytParked) {
      // a different show wipes the old video for good — transcript goes too
      wlogScope("video wiped by new content");
      cancelYtWaiter();
      try { fetch("/video_closed", { method: "POST" }).catch(() => {}); }
      catch (e) {}
    }
    content.innerHTML = "";
    focusReset();          // new content always opens on the wide shot
    ytLive = ytParked = null;
    let src = target, kind = "iframe", label = target;

    if (/^ytsearch:/i.test(target)) {
      // scope-native YouTube search (Brad, 2026-07-30): a grid of results
      // on the glass; tapping one plays it right here. No login, no ads
      // removed — just search-and-watch without leaving the scope.
      const q = target.replace(/^ytsearch:\s*/i, "").trim();
      kind = "grid";
      label = 'YouTube search — "' + q + '"';
      content.innerHTML =
        "<div class='ytwait'>searching the tube&hellip;</div>";
      fetch("/yt_search?q=" + encodeURIComponent(q))
        .then(r => r.json())
        .then(d => {
          if (!content.querySelector(".ytwait")) return; // superseded
          const list = d.results || [];
          if (!list.length) {
            content.innerHTML =
              "<div class='ytwait'>nothing found &mdash; try different words</div>";
            return;
          }
          const grid = document.createElement("div");
          grid.className = "ytgrid";
          list.forEach(v => {
            const card = document.createElement("div");
            card.className = "ytcard";
            const img = new Image();
            img.src = "https://i.ytimg.com/vi/" + v.id + "/mqdefault.jpg";
            const t = document.createElement("div");
            t.className = "yttitle";
            t.textContent = v.title;
            const meta = document.createElement("div");
            meta.className = "ytmeta";
            const dur = v.duration
              ? Math.floor(v.duration / 60) + ":"
                + String(Math.floor(v.duration % 60)).padStart(2, "0") : "";
            meta.textContent = v.channel + (dur ? "  ·  " + dur : "");
            card.append(img, t, meta);
            card.onclick = () => {
              const url = "https://www.youtube.com/watch?v=" + v.id;
              try { fetch("/video_opened", { method: "POST",
                body: JSON.stringify({ url, title: v.title }) })
                .catch(() => {}); } catch (err) {}
              wlogScope("grid pick: " + v.id);
              show(url);
            };
            grid.appendChild(card);
          });
          content.innerHTML = "";
          content.appendChild(grid);
        })
        .catch(() => {
          content.innerHTML =
            "<div class='ytwait'>search line's down &mdash; try again</div>";
        });
    } else if (/^https?:\/\//i.test(target)) {
      const yt = target.match(YTID_RE);
      if (yt) {
        // loads PAUSED (autoplay=0): Gus says his piece first, then
        // playWhenGusDone presses play. enablejsapi powers pause/resume.
        src = "https://www.youtube.com/embed/" + yt[1]
            + "?autoplay=0&enablejsapi=1";
        ytLive = yt[1];
        playWhenGusDone();
      } else if (/\.(png|jpe?g|gif|webp|svg|bmp)(\?|$)/i.test(target)) {
        kind = "img";           // a straight picture off the web (schematics,
                                // product shots) — an <img> beats an iframe
      } else if (NO_EMBED.test(target)) {
        kind = "card";          // stores and socials refuse to be framed
                                // (X-Frame-Options) — a dead grey box on
                                // camera is worse than an honest card
      }
      label = target.replace(/^https?:\/\//, "");
    } else { // a local file — the filing cabinet, or anywhere in the workshop
      // Split ?query and #fragment off FIRST: a generated drawing arrives as
      // block.html?b=zener, and percent-encoding the "?" into the filename
      // 404'd every fresh prez onto a dark glass (round six and seven — the
      // "knobs painted over the drawing" nights were really this).
      const urlM = target.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
      const qs = urlM[2] || "", frag = urlM[3] || "";
      target = urlM[1];
      let rel = target.replace(/\\/g, "/").replace(/^\.?\//, "");
      // tolerate absolute paths and stray prefixes: anchor on the workshop
      // root if it's in the path, else on shop_library/. Any repo file is
      // showable now (the 7/27 rehearsal 404'd on a project .md, twice).
      const rootAnchor = rel.lastIndexOf("the_collective/");
      if (rootAnchor >= 0) rel = rel.slice(rootAnchor + "the_collective/".length);
      const ext = (rel.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || "";
      const libAnchor = rel.lastIndexOf("shop_library/");
      const asText = ["md", "txt", "log", "csv"].includes(ext);
      if (libAnchor >= 0 && !asText) {
        rel = rel.slice(libAnchor + "shop_library/".length);
        src = "/library/" + rel.split("/").map(encodeURIComponent).join("/")
            + qs + frag;
      } else {
        // /doc/ serves the whole repo read-only and renders text readable;
        // it also resolves shop_library/... shorthand, so text files from
        // the cabinet get the pretty treatment too
        if (libAnchor >= 0) rel = rel.slice(libAnchor);
        src = "/doc/" + rel.split("/").map(encodeURIComponent).join("/")
            + qs + frag;
      }
      label = rel;
      if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) kind = "img";
      else if (["mp4", "webm"].includes(ext)) kind = "video";
      else if (ext === "pdf" && opts.page) src += "#page=" + opts.page;
      // teaching cards (shop_library/circuits/) read #N as their stage, so
      // page= steps an animated card the same way it turns a manual's pages
      else if (ext === "html" && opts.page) src += "#" + opts.page;
    }
    if (kind === "grid") {
      // the search grid built itself asynchronously above — nothing to add
    } else if (kind === "img") {
      const el = new Image(); el.src = src; content.appendChild(el);
      el.onerror = () => {
        content.innerHTML = "";
        content.appendChild(/^https?:/i.test(target) ? linkCard(target)
                                                     : missingCard(label));
      };
    } else if (kind === "video") {
      const el = document.createElement("video");
      el.src = src; el.controls = true; el.autoplay = true; content.appendChild(el);
    } else if (kind === "card") {
      content.appendChild(linkCard(target));
    } else {
      const el = document.createElement("iframe");
      el.src = src;
      el.allow = "autoplay; fullscreen";
      content.appendChild(el);
      // A site that refuses framing leaves a blank box and fires no error we
      // can see (cross-origin). If nothing has painted by the time a real page
      // would have, swap in the card so Brad always has a way through.
      if (/^https?:/i.test(src)) {
        let painted = false;
        el.addEventListener("load", () => { painted = true; });
        setTimeout(() => {
          if (!painted && content.contains(el)) {
            content.innerHTML = "";
            content.appendChild(linkCard(target));
          }
        }, 4000);
      } else {
        // local doc: check it actually exists, swap in the honest card if not
        fetch(src.split("#")[0]).then(r => {
          if (!r.ok && content.contains(el)) {
            content.innerHTML = "";
            content.appendChild(missingCard(label));
          }
        }).catch(() => {});
      }
    }
    caption.textContent = label + (opts.page
      ? (/\.html?$/i.test(label) ? "  —  step " + opts.page : "  —  p." + opts.page)
      : "");
    // THE ESCAPE HATCH (Brad, 2026-08-01: clicked a product link inside a
    // framed catalogue and "it gives me a page that doesn't open"). The site
    // itself framed fine — what broke was a link INSIDE it, whose destination
    // either refuses framing or targets _blank. Neither is something we can
    // catch: a cross-origin frame's clicks and location are invisible to us by
    // browser security, full stop. So instead of detecting the failure, every
    // framed web page now carries a way out — one tap puts the real site in
    // Brad's real browser, where links behave like links. It lands in the bar
    // beside RETURN TO SCOPE, never inside the caption (that span is a clipped
    // single line and would eat the button).
    setViewerOut(kind === "iframe" && /^https?:\/\//i.test(src) ? src : null);
    viewer.className = "fx-" + (opts.fx === "fade" ? "fade" : "iris");
    viewer.classList.remove("hidden");
    requestAnimationFrame(() => requestAnimationFrame(() => viewer.classList.add("open")));
    document.body.classList.add("viewing");
    // WHAT GETS THE CAMERA MOVE (Brad, 2026-08-20). A schematic or a page of
    // text is a flat document: it starts on the glass, grows to fill the
    // frame, and Gus pushes in on the section he is talking about. A video
    // and a PT demo just go up full size — a video is already framed by
    // whoever shot it, and a trainer deck carries its own display
    // instructions. Anything self-directing (an .html card walks its own
    // stages) is left alone for the same reason.
    if ((opts.full || isFlatDoc(target)) && !prez.on) {
      // borrow the presentation stage without the clicker: the page owns
      // the whole frame until [hide] hands it back
      growToFrame();
      wlogScope("show: full frame " + label);
    }
  }

  const VIDEO_RE = /\.(mp4|webm|mov|mkv)(\?|#|$)/i;
  const FLAT_RE = /\.(pdf|png|jpe?g|gif|webp|bmp|svg|tiff?|txt|md)(\?|#|$)/i;

  function isFlatDoc(target) {
    if (!target) return false;
    if (YTID_RE.test(target) || VIDEO_RE.test(target)) return false;
    if (/^ytsearch:/i.test(target)) return false;
    return FLAT_RE.test(target);          // .html decks direct themselves
  }

  function hide() {
    const viewer = document.getElementById("viewer");
    if (viewer.classList.contains("hidden")) return;
    // A playing YouTube clip is PARKED by hide, never destroyed — Brad's
    // 16:11 bug: "pause the video" goes through [hide], and the old hide
    // rebuilt the iframe on re-show, restarting at 0:00. The position
    // lives in the iframe, so the iframe survives every hide; it's wiped
    // when something ELSE gets shown, or when the shop closes. Pictures
    // and docs have no position — those still get destroyed.
    const keepVideo = !!(ytLive
                         && document.querySelector("#viewerContent iframe"));
    cancelYtWaiter();  // a pending auto-play must not fire into a hidden video
    if (keepVideo) {
      ytCmd("pauseVideo");
      ytParked = ytLive;
      wlogScope("hide->parked video " + ytLive);
    } else {
      ytLive = ytParked = null;
    }
    // a full-frame show ([show: X full]) borrowed the presentation stage;
    // hand the frame back before the close animation or the bezel never
    // comes home (a REAL presentation keeps its stage — prezEnd owns that)
    if (!prez.on) {
      viewer.classList.remove("stage", "growing");
      viewer.style.transform = "";
      document.body.classList.remove("presenting");
    }
    viewer.classList.add("closing");
    hideTimer = setTimeout(() => {
      viewer.classList.add("hidden");
      viewer.classList.remove("closing", "open", "fx-iris", "fx-fade");
      if (!keepVideo) document.getElementById("viewerContent").innerHTML = "";
      document.body.classList.remove("viewing");
    }, 320);
  }

  // ── cue dispatch (from the /think stream) ────────────────────────────────
  // ── PRESENTATION MODE — Prez's stage (Brad's design, 2026-08-16) ─────────
  // Prez is invisible: the audience only ever sees GUS running his own
  // visual aid. So everything here is driven by Gus's voice or Brad's mouth,
  // never by a timer of its own. Flexibility is the rule — a presentation
  // that marches on while the room moved elsewhere is the failure mode.
  const prez = { on: false, held: false, handed: false, stage: 1,
                 target: null, waiter: null };

  function prezFrame() {          // where the glass sits, for the FLIP
    const g = document.getElementById("scopeScreen");
    return g ? g.getBoundingClientRect() : { left: 0, top: 0,
                                             width: innerWidth,
                                             height: innerHeight };
  }

  // THE HOUSE CAMERA MOVE (Brad's standard, 2026-08-20): everything that goes
  // up starts life on Gus's glass and GROWS from there to fill the frame. It
  // is his visual aid, so it comes out of his screen — a picture that simply
  // appears at full size looks like the rig took over the show. Prez has done
  // this since 08-16; a plain [show:] used to snap to full size with no move
  // at all, which is the same picture with the manners taken out.
  function growToFrame() {
    const viewer = document.getElementById("viewer");
    if (viewer.classList.contains("hidden")) return;
    const r = prezFrame();
    viewer.classList.remove("handed");
    viewer.classList.add("stage");
    // one frame pinned back down onto the glass, then let it out
    const sx = r.width / innerWidth, sy = r.height / innerHeight;
    viewer.style.transform =
      `translate(${r.left}px, ${r.top}px) scale(${sx}, ${sy})`;
    // Release it on the next frame — but NEVER depend on the frame alone.
    // A browser stops handing out animation frames whenever the page isn't
    // visible, so an rAF-only release leaves the presentation stranded at
    // postage-stamp size the moment the window is behind something. The
    // timer is the guarantee; whichever arrives first wins, once.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      viewer.classList.add("growing");
      viewer.style.transform = "none";
      document.body.classList.add("presenting");   // he's heard, not seen
    };
    requestAnimationFrame(() => requestAnimationFrame(release));
    setTimeout(release, 60);
    prez.handed = false;
    wlogScope("grew to full frame");
  }

  function prezGrow() {
    if (!prez.on) return;
    growToFrame();
  }

  // ── the push-in (Brad's standard, 2026-08-20) ────────────────────────────
  // "Our audience needs to see the details, not a giant busy page when a
  // specific section or part is the talking point."
  //
  // A full-frame schematic is a wall of ink at broadcast resolution. So the
  // camera moves with the talk: [focus: bottom-left] eases in on the corner
  // being discussed, [focus: out] pulls back to the whole sheet. Slow on
  // purpose — a snap-zoom reads as a glitch, a slow push reads as a camera.
  // Gus, Marin and Hal drive it; nothing here moves on a timer of its own.
  const FOCUS_SPOTS = {
    out: [50, 50, 1], wide: [50, 50, 1], back: [50, 50, 1], all: [50, 50, 1],
    whole: [50, 50, 1], full: [50, 50, 1],
    center: [50, 50, 2.0], centre: [50, 50, 2.0], middle: [50, 50, 2.0],
    top: [50, 20, 2.0], bottom: [50, 80, 2.0],
    left: [20, 50, 2.0], right: [80, 50, 2.0],
    "top-left": [22, 22, 2.3], "top-right": [78, 22, 2.3],
    "bottom-left": [22, 78, 2.3], "bottom-right": [78, 78, 2.3],
  };
  const FOCUS_ALIAS = { upper: "top", lower: "bottom", mid: "middle",
                        centre: "center", "upper-left": "top-left",
                        "upper-right": "top-right", "lower-left": "bottom-left",
                        "lower-right": "bottom-right", "middle-left": "left",
                        "middle-right": "right", "pull-back": "out",
                        "zoom-out": "out", "wide-shot": "wide" };

  function focus(args) {
    const content = document.getElementById("viewerContent");
    if (!content) return;
    let key = (args || "").trim().toLowerCase()
      .replace(/[_\s]+/g, "-").replace(/^(the|on|in|to)-/, "");
    key = FOCUS_ALIAS[key] || key;
    const spot = FOCUS_SPOTS[key];
    if (!spot) { wlogScope("focus: no such spot " + key); return; }
    const [x, y, z] = spot;
    content.style.transformOrigin = x + "% " + y + "%";
    content.style.transition = "transform 2.4s cubic-bezier(.4, 0, .2, 1)";
    content.style.transform = z === 1 ? "none" : "scale(" + z + ")";
    wlogScope("focus: " + key);
  }

  function focusReset() {         // new content always opens on the wide shot
    const content = document.getElementById("viewerContent");
    if (!content) return;
    content.style.transition = "none";
    content.style.transform = "none";
    content.style.transformOrigin = "50% 50%";
  }

  // Hand the frame BACK to Gus without losing the presentation — Brad's
  // rule: if Gus needs to explain something else or go on a rant, the screen
  // is his, and Prez picks up exactly where it left off afterwards.
  function prezHandBack() {
    if (!prez.on || prez.handed) return;
    const viewer = document.getElementById("viewer");
    const r = prezFrame();
    viewer.classList.add("handed");
    viewer.style.transform =
      `translate(${r.left}px, ${r.top}px) ` +
      `scale(${r.width / innerWidth}, ${r.height / innerHeight})`;
    document.body.classList.remove("presenting");
    prez.handed = true;
    prez.held = true;
    wlogScope("prez: handed the frame back to Gus (holding at stage "
              + prez.stage + ")");
  }

  function prezResume() {
    if (!prez.on) return;
    prez.held = false;
    if (prez.handed) prezGrow();
    wlogScope("prez: resumed at stage " + prez.stage);
  }

  function prezGoTo(n) {          // switch gears — follow what Gus is saying
    if (!prez.on) return;
    const f = document.querySelector("#viewerContent iframe");
    prez.stage = Math.max(1, n | 0);
    try {                          // same-origin: the card is served by us
      if (f && f.contentWindow) f.contentWindow.location.hash = "#" + prez.stage;
    } catch (e) { /* cross-origin card: it just keeps its own stage */ }
    wlogScope("prez: stage " + prez.stage);
  }

  function prezNext() { if (!prez.held) prezGoTo(prez.stage + 1); }

  function prezStart(target) {
    show(target);
    // a #N on the target is the money jump — the card opens on stage N, so
    // the clicker state starts there too (else the beats ride out of step)
    const jump = (String(target).match(/#(\d+)$/) || [])[1];
    prez.on = true; prez.held = false; prez.handed = false;
    prez.stage = jump ? parseInt(jump, 10) : 1;
    prez.target = target;
    // it appears on his glass first, then takes the frame when he finishes
    // the sentence he's introducing it with — or after five seconds, so a
    // silent room never leaves it stranded on the small screen
    if (prez.waiter) clearInterval(prez.waiter);
    const t0 = Date.now();
    prez.waiter = setInterval(() => {
      const busy = window.GusVoiceBusy ? GusVoiceBusy() : false;
      if (busy && Date.now() - t0 < 5000) return;
      clearInterval(prez.waiter); prez.waiter = null;
      prezGrow();
    }, 200);
    wlogScope("prez: started " + target);
  }

  function prezEnd() {
    if (prez.waiter) { clearInterval(prez.waiter); prez.waiter = null; }
    const viewer = document.getElementById("viewer");
    viewer.classList.remove("stage", "growing", "handed");
    viewer.style.transform = "";
    document.body.classList.remove("presenting");
    prez.on = false; prez.held = false; prez.handed = false;
    hide();                        // auto-OBS returns the scene from here
    wlogScope("prez: ended");
  }

  function cue(raw) {
    const m = raw.match(/^\[(\w+):?\s*([^\]]*)\]$/);
    if (!m) return;
    lastVoiceAt = performance.now(); idle.on = false; // any cue wakes the face
    const verb = m[1].toLowerCase(), args = m[2].trim();
    if (verb === "prez") {          // the presentation stage — Prez is silent
      const a = args.toLowerCase();
      if (a === "end" || a === "off") prezEnd();
      else if (a === "back" || a === "hold") prezHandBack();
      else if (a === "resume" || a === "on") prezResume();
      else if (a === "next") prezNext();
      else if (/^\d+$/.test(a)) prezGoTo(parseInt(a, 10));
      else prezStart(args);
    }
    else if (verb === "show") show(args);
    else if (verb === "focus") focus(args);  // push in on the part he's on
    else if (verb === "open") openOut(args);  // hand a real page to Brad's browser
    else if (verb === "hide") hide();
    else if (verb === "face") {
      let f = args.toLowerCase().replace(/[_\s]+/g, "-");
      if (f === "warm" || f === "warm-smile") { // the smile that grows slow
        moodRamp = 0.03; f = "smile";
      }
      const alias = { yikes: "grimace", tongue: "silly", "big-smile": "happy",
                      mad: "angry", bored: "skeptical", confused: "huh",
                      cry: "sad", tired: "sleepy", giggle: "laugh",
                      shocked: "surprised", wow: "surprised" };
      f = alias[f] || f;
      if (f === "neutral") mood = "neutral";
      else if (EXPR[f]) { mood = f; moodUntil = performance.now() + 6000; }
      else if (["blink", "wink", "roll", "eyeroll", "look-left", "look-right", "left", "right"]
               .includes(f)) {
        eyeAnim = f.replace("eyeroll", "roll").replace("look-", "");
        eyeT0 = performance.now();
      }
    } else if (verb === "bit") {
      const b = args.toLowerCase();
      if (b === "taps") { bit = "taps"; bitT0 = performance.now(); bitDur = playTaps() || 9000; }
      else if (b === "womp" || b === "sad-trombone" || b === "sadtrombone") playWomp();
      else if (b.includes(".")) playBitFile(args);
      else noSignalUntil = performance.now() + 1400;
    }
  }

  // ── knobs ────────────────────────────────────────────────────────────────
  function initKnobs() {
    knob("knobVolume", 1.0, 0, 1.5, v => { volume = v; if (master) master.gain.value = v; });
    knob("knobGlow", 14, 2, 30, v => { glow = v; });
    knob("knobFocus", 0.7, 0.15, 1, v => { focusK = v; });
    knob("knobHoriz", 1, 0.25, 2.5, v => { sweepK = v; });
  }
  // every knob remembers where Brad left it (localStorage, per knob id)
  function knob(id, val, min, max, apply) {
    const el = document.getElementById(id);
    if (!el) return;
    const saved = parseFloat(localStorage.getItem("gusknob:" + id));
    if (!isNaN(saved)) val = Math.max(min, Math.min(max, saved));
    const dial = el.querySelector(".dial");
    const setAngle = () =>
      dial.style.transform = `rotate(${-135 + ((val - min) / (max - min)) * 270}deg)`;
    setAngle(); apply(val);
    let dragging = false, startY = 0, startVal = 0;
    dial.addEventListener("pointerdown", e => {
      dragging = true; startY = e.clientY; startVal = val;
      dial.setPointerCapture(e.pointerId);
    });
    dial.addEventListener("pointermove", e => {
      if (!dragging) return;
      val = Math.max(min, Math.min(max, startVal + (startY - e.clientY) * (max - min) / 150));
      setAngle(); apply(val);
    });
    dial.addEventListener("pointerup", () => {
      dragging = false;
      try { localStorage.setItem("gusknob:" + id, String(val)); } catch (e) {}
    });
  }

  function power(on) { powered = on; powerT = performance.now(); }

  document.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
  document.addEventListener("DOMContentLoaded", init);

  return { sink, cue, show, hide, park, power, hearBrad, knob, startle,
           focus, growToFrame,   // the house camera move (Brad, 2026-08-20)
           thinking, // the page tells the face when the brain is working
           level: getRMS, // live voice level — crt.js drives the bezel glow
           face: n => cue("[face: " + n + "]"),
           // Prez's stage. `prez` is read-only state for the page's own
           // logic (stage advance on Gus's voice, hand-back on a detour).
           prez, prezStart, prezNext, prezGoTo, prezHandBack, prezResume,
           prezEnd };
})();
