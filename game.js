(() => {
  "use strict";

  // ---------- Config ----------
  const SIZE = 36;
  const GAME_MS = 60000;
  const TICK = 100;
  const WARN_TO_RED_MS = 3000;
  const DRAIN_PER_RED_PER_TICK = 0.5;   // 5% per second per red node (100ms ticks)
  const REGEN_PER_TICK = 0.1;           // 1%/s slow recovery when no reds (tweak or set 0)
  const HOLD_MS = 600;                  // red hard-reboot hold time
  const GREEN_PENALTY = 100;            // points lost for clicking / pressing S on a healthy pod
  const COMBO_WINDOW = 2000, COMBO_NEEDED = 3, COMBO_DURATION = 5000;
  const KEY = "serverSniperScores";
  const DB = (window.SNIPER_DB_URL || "").replace(/\/+$/, "");   // from config.js
  const $ = s => document.querySelector(s);

  // ---------- State ----------
  let pods = [], cells = [];
  let t = 0, health = 100, score = 0, running = false, loop = null;
  let hovered = -1, resolveTimes = [], comboUntil = -1;
  let spikeDone = false, monkeyDone = false;
  let holdIdx = -1, holdStart = 0, holdRaf = null;
  let termIdx = -1;
  let mouse = { x: 0, y: 0 };

  // ---------- Audio ----------
  let actx = null;
  const audio = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());
  function beep(freq = 1200, dur = 0.04, type = "square", vol = 0.05) {
    try {
      const a = audio(), o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = vol;
      o.connect(g); g.connect(a.destination);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
      o.start(); o.stop(a.currentTime + dur);
    } catch (e) {}
  }
  function siren(seconds = 3) {
    try {
      const a = audio(), o = a.createOscillator(), g = a.createGain();
      o.type = "sawtooth"; g.gain.value = 0.06;
      o.connect(g); g.connect(a.destination);
      const now = a.currentTime;
      for (let i = 0; i < seconds * 2; i++) {
        o.frequency.setValueAtTime(i % 2 ? 900 : 600, now + i * 0.5);
      }
      o.start(); o.stop(now + seconds);
    } catch (e) {}
  }

  // ---------- Grid ----------
  const grid = $("#grid");
  for (let i = 0; i < SIZE; i++) {
    const c = document.createElement("div");
    c.className = "pod healthy";
    c.dataset.i = i;
    c.innerHTML = `<span class="ico">🟢</span><span class="nm">pod-${String(i + 1).padStart(2, "0")}</span>`;
    grid.appendChild(c);
    cells.push(c);
  }

  const ICON = { healthy: "🟢", warning: "⚠️", critical: "🔥" };
  function setState(i, state) {
    pods[i].state = state;
    pods[i].since = t;
    cells[i].className = "pod " + state;
    cells[i].firstChild.textContent = ICON[state];
  }
  const reds = () => pods.filter(p => p.state === "critical").length;
  const idxOf = state => pods.map((p, i) => (p.state === state ? i : -1)).filter(i => i >= 0);
  // Seeded RNG: every run uses the same seed, so every player gets the same game.
  // Change SEED to get a different (but still identical-for-everyone) layout.
  const SEED = 1337;
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rng = mulberry32(SEED);
  const pickRoll = (arr, r) => arr[Math.floor(r * arr.length)];
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  // Fixed spawn schedule, built once per run from the seed.
  // Pattern repeats every wave, so the Y/R mix is balanced at any point in the game.
  // Each entry: offset in ms within the wave, type. Waves get tighter as the game goes on.
  const WAVE_EARLY = [[0, "Y"], [600, "Y"], [1200, "Y"], [1800, "Y"], [2300, "R"], [2800, "Y"], [3400, "Y"]]; // 4.4s wave: 6 yellow, 1 red
  const WAVE_LATE  = [[0, "Y"], [500, "Y"], [1000, "R"], [1500, "Y"], [2000, "Y"], [2500, "R"], [3000, "Y"]]; // 3.6s wave: 5 yellow, 2 red
  function buildSchedule() {
    const r = mulberry32(SEED + 1), list = [];
    let start = 1500;
    while (start < GAME_MS - 2000) {
      const late = start >= 30000;
      const wave = late ? WAVE_LATE : WAVE_EARLY;
      for (const [off, type] of wave) {
        const at = start + off;
        if (at < GAME_MS - 2000) list.push({ at, type, roll: r() });
      }
      start += late ? 3600 : 4400;
    }
    return list;
  }
  let schedule = [], schedPos = 0;

  // ---------- Log / HUD ----------
  function log(msg, cls = "") {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = `[${((GAME_MS - t) / 1000).toFixed(0).padStart(2, "0")}s] ${msg}`;
    $("#log").prepend(d);
    while ($("#log").children.length > 14) $("#log").lastChild.remove();
  }
  const multiplier = () => (t < comboUntil ? 2 : 1);
  function renderHUD() {
    $("#timer").textContent = Math.max(0, (GAME_MS - t) / 1000).toFixed(1);
    $("#score").textContent = score.toLocaleString();
    const h = Math.max(0, health);
    $("#healthText").textContent = Math.round(h) + "%";
    const f = $("#healthFill");
    f.style.width = h + "%";
    f.className = h < 30 ? "low" : h < 60 ? "mid" : "";
    const c = $("#combo");
    if (multiplier() === 2) {
      c.textContent = "x2 " + ((comboUntil - t) / 1000).toFixed(1) + "s";
      c.className = "on";
    } else { c.textContent = "x1"; c.className = "dim"; }
  }
  function pop(i, text, big) {
    const r = cells[i].getBoundingClientRect();
    const p = document.createElement("div");
    p.className = "pop" + (big ? " big" : "");
    p.textContent = text;
    p.style.left = r.left + r.width / 2 - 20 + "px";
    p.style.top = r.top + "px";
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 800);
    return p;
  }

  // ---------- Resolve ----------
  function resolve(i, from) {
    if (!running) return false;
    const st = pods[i].state;
    if (st === "healthy") return false;
    const base = st === "warning" ? 200 : 500;
    const pts = base * multiplier();
    score += pts;
    setState(i, "healthy");
    cells[i].classList.add("fixed");
    setTimeout(() => cells[i].classList.remove("fixed"), 350);
    pop(i, "+" + pts, multiplier() === 2);
    beep(st === "warning" ? 900 : 600, 0.08, "triangle", 0.08);
    log(`${from} fixed pod-${String(i + 1).padStart(2, "0")} (+${pts})`, "good");

    resolveTimes.push(t);
    resolveTimes = resolveTimes.filter(x => t - x <= COMBO_WINDOW);
    if (resolveTimes.length >= COMBO_NEEDED && t >= comboUntil) {
      comboUntil = t + COMBO_DURATION;
      log("COMBO! 2x score for 5s", "good");
      beep(1500, 0.2, "sawtooth", 0.07);
    }
    return true;
  }

  // Wrong-target penalty: clicking or pressing S on a healthy (green) pod
  function penalize(i, how) {
    if (!running || pods[i].state !== "healthy") return;
    score = Math.max(0, score - GREEN_PENALTY);
    pop(i, "-" + GREEN_PENALTY, false).style.color = "var(--r)";
    cells[i].classList.remove("fixed");
    beep(160, 0.12, "sawtooth", 0.07);
    log(`Misfire (${how}) on healthy pod-${String(i + 1).padStart(2, "0")} (-${GREEN_PENALTY})`, "ev");
    renderHUD();
  }

  // ---------- Interactions ----------
  cells.forEach((c, i) => {
    c.addEventListener("mouseenter", () => (hovered = i));
    c.addEventListener("mouseleave", () => { if (hovered === i) hovered = -1; cancelHold(); });

    // Drag & drop load balancer
    c.addEventListener("dragover", e => { e.preventDefault(); c.classList.add("drop"); });
    c.addEventListener("dragleave", () => c.classList.remove("drop"));
    c.addEventListener("drop", e => {
      e.preventDefault(); c.classList.remove("drop");
      if (pods[i].state === "warning") resolve(i, "LB");
      else beep(200, 0.1, "sawtooth", 0.05);
    });

    // Hold to reboot
    c.addEventListener("mousedown", e => {
      if (e.button !== 0 || !running) return;
      if (pods[i].state === "healthy") return penalize(i, "click");
      if (pods[i].state !== "critical") return;
      startHold(i);
    });
    c.addEventListener("dblclick", () => {
      if (!running || pods[i].state !== "critical") return;
      cancelHold();
      openTerminal(i);
    });
  });
  window.addEventListener("mouseup", cancelHold);
  window.addEventListener("mousemove", e => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    const r = $("#ring");
    r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
  });
  $("#lb").addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", "lb"));

  function startHold(i) {
    cancelHold();
    holdIdx = i; holdStart = performance.now();
    const ring = $("#ring"), fill = $("#ringFill");
    ring.style.left = mouse.x + "px"; ring.style.top = mouse.y + "px";
    ring.classList.remove("hidden");
    const C = 163.4;
    const step = () => {
      const p = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
      fill.style.strokeDashoffset = C * (1 - p);
      if (p >= 1) { const idx = holdIdx; cancelHold(); resolve(idx, "Reboot"); return; }
      holdRaf = requestAnimationFrame(step);
    };
    holdRaf = requestAnimationFrame(step);
  }
  function cancelHold() {
    if (holdRaf) cancelAnimationFrame(holdRaf);
    holdRaf = null; holdIdx = -1;
    $("#ring").classList.add("hidden");
    $("#ringFill").style.strokeDashoffset = 163.4;
  }

  // Keyboard: S = scale up
  window.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;
    if (e.key.toLowerCase() === "s" && running && hovered >= 0) {
      beep(1200, 0.03);
      if (pods[hovered].state === "warning") resolve(hovered, "Scale-up");
      else if (pods[hovered].state === "healthy" && !e.repeat) penalize(hovered, "S key");
    }
  });

  // Terminal
  const term = $("#terminal"), tin = $("#termInput");
  function openTerminal(i) {
    termIdx = i;
    const name = "pod-" + String(i + 1).padStart(2, "0");
    $("#termTitle").textContent = name; $("#termPod").textContent = name;
    const r = cells[i].getBoundingClientRect();
    term.classList.remove("hidden", "err");
    term.style.left = Math.min(window.innerWidth - 300, Math.max(10, r.left)) + "px";
    term.style.top = Math.min(window.innerHeight - 130, r.top + r.height * 0.4) + "px";
    tin.value = ""; tin.focus();
  }
  function closeTerminal() { term.classList.add("hidden"); termIdx = -1; tin.blur(); }
  $("#termClose").addEventListener("click", closeTerminal);
  tin.addEventListener("keydown", e => {
    if (e.key === "Escape") return closeTerminal();
    if (e.key === "Enter") {
      const v = tin.value.trim().toLowerCase();
      if ((v === "kill" || v === "fix") && termIdx >= 0) {
        const idx = termIdx; closeTerminal();
        resolve(idx, "Terminal");
      } else {
        term.classList.remove("err"); void term.offsetWidth; term.classList.add("err");
        beep(180, 0.15, "sawtooth", 0.06); tin.value = "";
      }
    } else beep(1800 + Math.random() * 400, 0.015, "square", 0.03);
  });

  // ---------- Chaos events ----------
  function screenShake() {
    document.body.classList.add("shake", "alarm");
    setTimeout(() => document.body.classList.remove("shake"), 800);
    setTimeout(() => document.body.classList.remove("alarm"), 3000);
  }
  function trafficSpike() {
    log("TRAFFIC SPIKE: 6 pods overloaded", "ev");
    shuffle(idxOf("healthy")).slice(0, 6).forEach(i => setState(i, "warning"));
    beep(500, 0.3, "sawtooth", 0.08);
  }
  function chaosMonkey() {
    log("CHAOS MONKEY: 8 pods crashed!", "ev");
    const pool = shuffle(pods.map((_, i) => i).filter(i => pods[i].state !== "critical"));
    pool.slice(0, 8).forEach(i => setState(i, "critical"));
    screenShake(); siren(3);
  }

  // ---------- Game loop ----------
  function tick() {
    t += TICK;
    const remaining = GAME_MS - t;

    // scripted events (T-minus = seconds remaining)
    if (!spikeDone && remaining <= 45000) { spikeDone = true; trafficSpike(); }
    if (!monkeyDone && remaining <= 20000) { monkeyDone = true; chaosMonkey(); }

    // warning -> critical
    pods.forEach((p, i) => { if (p.state === "warning" && t - p.since >= WARN_TO_RED_MS) setState(i, "critical"); });

    // scripted spawns: same types at the same times for every player
    while (schedPos < schedule.length && schedule[schedPos].at <= t) {
      const s = schedule[schedPos++];
      const h = idxOf("healthy");
      if (h.length) setState(pickRoll(h, s.roll), s.type === "Y" ? "warning" : "critical");
    }

    // health
    const r = reds();
    if (r > 0) health -= r * DRAIN_PER_RED_PER_TICK;
    else health = Math.min(100, health + REGEN_PER_TICK);

    // per-second scoring
    if (t % 1000 === 0) {
      if (health > 80) score += 50;
      if (health < 30) { score = Math.max(0, score - 100); log("Downtime penalty -100", "ev"); }
    }

    renderHUD();
    if (health <= 0) { health = 0; renderHUD(); return end(false); }
    if (t >= GAME_MS) end(true);
  }

  function start() {
    const name = $("#nameInput").value.trim() || "Anonymous";
    localStorage.setItem("sniperLastName", name);
    audio().resume && audio().resume();
    pods = Array.from({ length: SIZE }, () => ({ state: "healthy", since: 0 }));
    cells.forEach((c, i) => setState(i, "healthy"));
    t = 0; health = 100; score = 0; resolveTimes = []; comboUntil = -1;
    spikeDone = monkeyDone = false; hovered = -1;
    rng = mulberry32(SEED + 2);              // reset event RNG so shuffles repeat
    schedule = buildSchedule(); schedPos = 0;
    $("#log").innerHTML = "";
    document.body.classList.remove("alarm", "shake");
    $("#startOverlay").classList.add("hidden");
    $("#endOverlay").classList.add("hidden");
    running = true;
    log("Incident response started. Good luck, SRE.");
    renderHUD();
    loop = setInterval(tick, TICK);
  }

  function end(survived) {
    running = false; clearInterval(loop);
    cancelHold(); closeTerminal();
    document.body.classList.remove("alarm");
    const name = localStorage.getItem("sniperLastName") || "Anonymous";
    const entry = { name, score, survived, ts: Date.now() };
    const rank = saveScore(entry);
    const title = $("#endTitle");
    title.textContent = survived ? "SYSTEM SURVIVED" : "INFRASTRUCTURE COLLAPSE";
    title.className = survived ? "" : "bad";
    $("#endSub").textContent = survived ? `Nice work, ${name}. Cluster stayed up for 60s.` : `${name}, the cluster went down at ${(t / 1000).toFixed(1)}s.`;
    $("#endScore").textContent = score.toLocaleString();
    $("#endRank").textContent = DB ? "Saving score online..." : `Leaderboard rank: #${rank}`;
    if (DB) {
      saveRemote(entry)
        .then(r => { $("#endRank").textContent = `Leaderboard rank: #${r}`; })
        .catch(() => { $("#endRank").textContent = `Saved locally (#${rank}). Online save failed, check connection.`; });
    }
    $("#endOverlay").classList.remove("hidden");
    beep(survived ? 1000 : 120, 0.5, "triangle", 0.1);
  }

  // ---------- Leaderboard persistence ----------
  function saveScore(entry) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) {}
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    const rank = list.indexOf(entry) + 1;
    list = list.slice(0, 20);
    localStorage.setItem(KEY, JSON.stringify(list));   // fires 'storage' event in other windows
    try { new BroadcastChannel("sniper").postMessage("update"); } catch (e) {}
    return rank;
  }

  // Online leaderboard: Firebase Realtime Database over plain REST (no SDK needed).
  // Set the URL in config.js. Leave it empty to use localStorage only.
  async function saveRemote(entry) {
    const res = await fetch(`${DB}/scores.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error("save failed " + res.status);
    const all = await (await fetch(`${DB}/scores.json`)).json() || {};
    const higher = Object.values(all).filter(s => s && s.score > entry.score).length;
    return higher + 1;
  }

  // ---------- Wire up ----------
  $("#nameInput").value = "";   // always start blank: a new player each time
  $("#startBtn").addEventListener("click", start);
  $("#againBtn").addEventListener("click", () => {
    $("#endOverlay").classList.add("hidden");
    $("#nameInput").value = "";                       // clear name for the next player
    $("#startOverlay").classList.remove("hidden");
    $("#nameInput").focus();
  });
  $("#nameInput").addEventListener("keydown", e => { if (e.key === "Enter") start(); });
  pods = Array.from({ length: SIZE }, () => ({ state: "healthy", since: 0 }));
  renderHUD();
})();
