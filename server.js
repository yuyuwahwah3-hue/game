"use strict";
/*
 * Perang Strategi - Server multiplayer TIM vs TIM (Railway)
 *
 * - 2 tim: HIJAU (markas Hutan Sancang, slot 0-3) vs MERAH (markas Giri Kancana, slot 4-7).
 * - Mode: "pvp" (lawan pemain) atau "ai" (lawan bot), ukuran tim 1-4 (1v1 s/d 4v4).
 * - "Cari Teman" (joinParty): party bareng teman, isi tim HIJAU, lalu lawan dicari/diisi bot.
 * - "Cari Match" (joinMatch): dipasangkan otomatis ke slot kosong manapun.
 * - Room mulai: kedua tim penuh = langsung; kalau tidak, LOBBY_WAIT_MS sejak pemain pertama masuk,
 *   slot kosong yg tersisa diisi BOT (baik mode "ai" maupun "pvp" yg kekurangan lawan).
 * - Tiap room = 1 VM terpisah berisi kode simulasi game (sim.js), state tidak bocor antar room.
 * - Server authoritative: client hanya kirim input, slot (owner+tim) ditentukan server dari koneksi.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || "6", 10);        // batas room AKTIF (mulai) bersamaan
const LOBBY_WAIT_MS = parseInt(process.env.LOBBY_WAIT_MS || "15000", 10);
const TICK_HZ = parseInt(process.env.TICK_HZ || "20", 10);
const SNAP_EVERY = parseInt(process.env.SNAP_EVERY || "2", 10);      // kirim snapshot tiap N tick (20/2 = 10Hz)
const MAX_PLAYERS = 8; // 4 slot per tim x 2 tim
const SLOW_TICK_MS = 35;                                              // peringatan jika 1 tick > ini

const SIM_CODE = fs.readFileSync(path.join(__dirname, "sim.js"), "utf8");
const SIM_SCRIPT = new vm.Script(SIM_CODE, { filename: "sim.js" });   // dikompilasi sekali, dipakai semua room

// ---------- stub DOM/canvas minimal utk menjalankan kode game di Node ----------
function ctxStub() {
  return new Proxy(function () {}, {
    get: (t, p) => (p === "canvas" ? {} : p === "measureText" ? () => ({ width: 0 }) : ctxStub()),
    apply: () => ctxStub(),
    set: () => true,
  });
}
function fakeEl() {
  return {
    getContext: () => ctxStub(), style: {}, remove() {}, appendChild() {}, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    textContent: "", width: 100, height: 100, onclick: null, value: "", files: [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
}
function makeSandbox(room) {
  const sb = {
    console, Math, Date, Set, Map, Array, Object, JSON, Uint8Array, Float32Array, Float64Array,
    setTimeout, clearTimeout, setInterval, clearInterval,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
    requestAnimationFrame: () => 0, innerWidth: 1000, innerHeight: 700,
    document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), body: fakeEl(), head: fakeEl(), addEventListener() {} },
    Image: function () { return {}; }, Peer: function () { return { on() {}, connect() {} }; },
    FileReader: function () {}, location: { reload() {} }, addEventListener() {}, navigator: {},
    __toasts: [],                                                     // tK() dibelokkan ke sini, lalu dikirim ke client
  };
  sb.window = sb;
  return sb;
}

// ---------- state server ----------
// Slot 0-3 = tim HIJAU (markas Hutan Sancang), slot 4-7 = tim MERAH (markas Giri Kancana).
// Mode Nv N memakai N slot per tim (1v1 -> slot 0 & 4 saja terpakai, dst).
let nextRoomId = 1;
const rooms = new Map();
const lobbyQueues = {}; // key "mode:N" -> room lobi yg masih menerima pemain (party/cari-teman)
const matchQueues = {}; // key "mode:N" -> antrean "cari match" per ukuran tim

function queueKey(mode, n) { return mode + ":" + n; }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) {
  const data = JSON.stringify(obj);
  for (const c of room.clients) if (c && c.readyState === 1) c.send(data);
}
function activeRoomCount() { let n = 0; for (const r of rooms.values()) if (r.state === "playing") n++; return n; }
function slotTeam(slot) { return slot < 4 ? "A" : "B"; }

function createRoom(mode, teamSize) {
  const room = {
    id: nextRoomId++, mode, teamSize,              // mode: "ai" | "pvp"
    state: "lobby", clients: new Array(8).fill(null), players: new Array(8).fill(null),
    bots: new Array(8).fill(false),
    createdAt: Date.now(), startTimer: null, tickTimer: null, tickN: 0, sb: null,
    stats: { ticks: 0, totalMs: 0, maxMs: 0, slow: 0 }, endSent: false,
  };
  rooms.set(room.id, room);
  return room;
}
function teamSlots(room, team) { const base = team === "A" ? 0 : 4; return [0, 1, 2, 3].slice(0, room.teamSize).map((i) => base + i); }
function filledSlots(room) { return teamSlots(room, "A").concat(teamSlots(room, "B")).filter((s) => room.players[s]); }
function playerCount(room) { return filledSlots(room).length; }
function humanCount(room) { return filledSlots(room).filter((s) => !room.bots[s]).length; }
function roomPublicPlayers(room) {
  return room.players.map((p, i) => p && { name: p.name, photo: p.photo, team: slotTeam(i), bot: room.bots[i] });
}
function lobbyInfo(room) {
  return { type: "lobby", room: room.id, mode: room.mode, teamSize: room.teamSize,
    players: roomPublicPlayers(room), startsInMs: room.startTimer ? Math.max(0, room.startAt - Date.now()) : null };
}

// ---- "Cari Teman": party lobi bersama, host party yg pencet mulai (atau otomatis kalau penuh) ----
function joinParty(ws, msg) {
  if (ws.room) return;
  const mode = msg.vs === "ai" ? "ai" : "pvp";
  const n = Math.max(1, Math.min(4, msg.teamSize | 0));
  const key = queueKey(mode + ":party", n);
  let room = lobbyQueues[key] && lobbyQueues[key].state === "lobby" ? lobbyQueues[key] : null;
  if (!room) { room = createRoom(mode, n); lobbyQueues[key] = room; }
  const mySlots = teamSlots(room, "A"); // party selalu isi tim A dulu; tim B diisi "Cari Teman" lain / bot / match
  const slot = mySlots.find((s) => !room.players[s]);
  if (slot === undefined) return send(ws, { type: "busy", message: "Party penuh." });
  placePlayer(room, slot, ws, msg);
  send(ws, { type: "party", room: room.id, isLeader: slot === mySlots[0] });
  broadcast(room, lobbyInfo(room));
  maybeAutoFillAndStart(room, key);
}

// ---- "Cari Match": dipasangkan otomatis dgn lawan (atau diisi bot kalau VS AI) ----
function joinMatch(ws, msg) {
  if (ws.room) return;
  const mode = msg.vs === "ai" ? "ai" : "pvp";
  const n = Math.max(1, Math.min(4, msg.teamSize | 0));
  const key = queueKey(mode, n);
  let room = matchQueues[key] && matchQueues[key].state === "lobby" ? matchQueues[key] : null;
  if (!room) { room = createRoom(mode, n); matchQueues[key] = room; }
  const empty = teamSlots(room, "A").concat(teamSlots(room, "B")).filter((s) => !room.players[s]);
  const slot = empty[0];
  if (slot === undefined) return send(ws, { type: "busy", message: "Server penuh, coba lagi." });
  placePlayer(room, slot, ws, msg);
  broadcast(room, lobbyInfo(room));
  maybeAutoFillAndStart(room, key);
}

function placePlayer(room, slot, ws, msg) {
  room.clients[slot] = ws;
  room.players[slot] = { name: String(msg.name || "Jenderal").slice(0, 20), photo: typeof msg.photo === "string" && msg.photo.length < 150000 ? msg.photo : null };
  room.bots[slot] = false;
  ws.room = room; ws.slot = slot;
  send(ws, { type: "assignOwner", owner: slot, team: slotTeam(slot), room: room.id });
  if (!room.startTimer && humanCount(room) >= 1) {
    room.startAt = Date.now() + LOBBY_WAIT_MS;
    room.startTimer = setTimeout(() => finalizeRoom(room), LOBBY_WAIT_MS);
  }
}

function maybeAutoFillAndStart(room, key) {
  const aFull = teamSlots(room, "A").every((s) => room.players[s]);
  const bFull = teamSlots(room, "B").every((s) => room.players[s]);
  if (aFull && bFull) { clearQueueRef(room); finalizeRoom(room); }
  else if (room.mode === "ai" && aFull) { clearQueueRef(room); finalizeRoom(room); } // VS AI: tim A penuh -> tim B diisi bot
}
function clearQueueRef(room) {
  for (const k of Object.keys(lobbyQueues)) if (lobbyQueues[k] === room) delete lobbyQueues[k];
  for (const k of Object.keys(matchQueues)) if (matchQueues[k] === room) delete matchQueues[k];
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients[ws.slot] = null;
  if (room.state === "lobby") {
    room.players[ws.slot] = null;
    clearTimeout(room.startTimer); room.startTimer = null;
    if (humanCount(room) === 0) destroyRoom(room);
    else {
      room.startAt = Date.now() + LOBBY_WAIT_MS;
      room.startTimer = setTimeout(() => finalizeRoom(room), LOBBY_WAIT_MS);
      broadcast(room, lobbyInfo(room));
    }
  } else if (room.state === "playing") {
    if (room.clients.every((c) => !c)) destroyRoom(room);
  }
  ws.room = null;
}

function destroyRoom(room) {
  clearTimeout(room.startTimer); clearInterval(room.tickTimer);
  room.state = "closed"; room.sb = null; rooms.delete(room.id);
  clearQueueRef(room);
}

// Waktu tunggu lobi habis (atau penuh/VS-AI-tim-A-penuh): isi slot kosong dgn bot lalu mulai.
// VS Player yg masih kekurangan lawan manusia saat waktu habis: slot kosong diisi bot juga (lebih
// baik main lawan bot drpd tidak jadi main sama sekali), KECUALI tim A (punya) masih kosong total.
function finalizeRoom(room) {
  if (room.state !== "lobby") return;
  clearTimeout(room.startTimer);
  clearQueueRef(room);
  if (humanCount(room) === 0) return destroyRoom(room);
  for (const s of teamSlots(room, "A").concat(teamSlots(room, "B"))) {
    if (!room.players[s]) {
      room.bots[s] = true;
      room.players[s] = { name: "Bot " + (s < 4 ? "Hijau" : "Merah") + (s % 4 + 1), photo: null };
    }
  }
  startRoom(room);
}

function startRoom(room) {
  if (room.state !== "lobby") return;
  room.state = "playing";
  const sb = makeSandbox(room);
  vm.createContext(sb);
  SIM_SCRIPT.runInContext(sb);
  room.sb = sb;
  vm.runInContext(`tK = function(m){ __toasts.push(String(m)); };`, sb);
  sb.__players = room.players; sb.__bots = room.bots;
  vm.runInContext(`
    mpIsHost = true; mpMyOwner = 0; mpGameStarted = true;
    for (var i=0;i<8;i++) mpPlayers[i] = __players[i] ? {name:__players[i].name, photo:null, bot:__bots[i]} : null;
    mpEnterGame();
  `, sb);
  broadcast(room, { type: "start", room: room.id, mode: room.mode, teamSize: room.teamSize,
    zones: vm.runInContext("__zonesForClient()", sb), players: roomPublicPlayers(room) });
  const dt = 1 / TICK_HZ;
  room.tickTimer = setInterval(() => tickRoom(room, dt), 1000 / TICK_HZ);
  console.log(`[room ${room.id}] MULAI ${room.mode} ${room.teamSize}v${room.teamSize} (bot: ${room.bots.filter(Boolean).length}). Room aktif: ${activeRoomCount()}`);
}

function tickRoom(room, dt) {
  if (room.state !== "playing" || !room.sb) return;
  const t0 = process.hrtime.bigint();
  try {
    vm.runInContext(`update(${dt})`, room.sb);
    if (room.bots.some(Boolean)) vm.runInContext(`__botTick()`, room.sb);
  } catch (e) {
    console.error(`[room ${room.id}] ERROR update:`, e.message);
    broadcast(room, { type: "end", reason: "ERROR SERVER — PERTEMPURAN BERAKHIR" });
    return destroyRoom(room);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const s = room.stats; s.ticks++; s.totalMs += ms; if (ms > s.maxMs) s.maxMs = ms; if (ms > SLOW_TICK_MS) s.slow++;
  room.tickN++;
  if (room.tickN % SNAP_EVERY === 0) sendSnapshot(room);
  const over = vm.runInContext("go", room.sb);
  if (over && !room.endSent) {
    room.endSent = true;
    const winner = vm.runInContext("__winningTeam()", room.sb); // "A" | "B" | null (seri/error)
    for (const s2 of filledSlots(room)) {
      const c = room.clients[s2]; if (!c || c.readyState !== 1) continue;
      const mine = winner ? (slotTeam(s2) === winner ? "KEMENANGAN! Timmu menguasai seluruh wilayah" : "KEKALAHAN — tim lawan menguasai seluruh wilayah") : "PERTEMPURAN BERAKHIR";
      c.send(JSON.stringify({ type: "end", reason: mine }));
    }
    setTimeout(() => destroyRoom(room), 3000);
  }
}

function sendSnapshot(room) {
  const snap = vm.runInContext(`(function(){
    var out=[], ids=[];
    for (var i=0;i<pc.length;i++){
      var p=pc[i];
      if(!p.al||p.hidden) continue;
      ids.push(i);
      out.push([Math.round(p.x*10)/10, Math.round(p.y*10)/10, Math.round(p.a*100)/100, p.team==='A'?1:0, p.i, Math.round(p.hp), Math.round(p.mhp), p.gen?1:0, p.owner|0, p.hf>0?1:0, p.ord?1:0]);
    }
    var t=[]; for (var k=0;k<tr.length;k++) t.push(tr[k].tm||'');
    var cA=0,cB=0; for (var q=0;q<tr.length;q++){ if(tr[q].tm==='A')cA++; else if(tr[q].tm==='B')cB++; }
    var gens=[]; for (var o=0;o<8;o++){ var g=pgens[o]; gens.push(g?[g.al?1:0, Math.round(g.hp/g.mhp*100), pc.indexOf(g)]:null); }
    var rs=[]; for (var r=0;r<8;r++) rs.push(mpRespawnTimers[r]?Math.max(0,Math.round((mpRespawnTimers[r]-performance.now())/1000)):0);
    return {ids:ids, p:out, t:t, cA:cA, cB:cB, gens:gens, rs:rs, min:Math.floor((performance.now()-mpGameStartTime)/60000)};
  })()`, room.sb);
  snap.type = "state";
  const toasts = room.sb.__toasts; if (toasts.length) snap.toasts = toasts.splice(0, toasts.length);
  const warnQ = room.sb.__warnQ.splice(0, room.sb.__warnQ.length);
  const deathQ = room.sb.__deathQ.splice(0, room.sb.__deathQ.length);
  const respQ = room.sb.__respQ.splice(0, room.sb.__respQ.length);
  const data = JSON.stringify(snap);
  for (let s = 0; s < room.clients.length; s++) {
    const c = room.clients[s];
    if (!c || c.readyState !== 1) continue;
    const mine = [];
    if (warnQ.includes(s)) mine.push("JENDERAL TERANCAM!");
    if (deathQ.includes(s)) mine.push("Jenderalmu gugur! Respawn dlm " + Math.round(room.sb.mpRespawnDelaySec()) + " detik...");
    if (respQ.includes(s)) mine.push("Jenderalmu respawn dgn 25 bidak baru!");
    if (mine.length) c.send(JSON.stringify(Object.assign({}, snap, { toasts: (snap.toasts || []).concat(mine) })));
    else c.send(data);
  }
}

function handleInput(ws, msg) {
  const room = ws.room;
  if (!room || room.state !== "playing" || !room.sb) return;
  if (msg.cmd !== "orderMove" || !msg.payload || !Array.isArray(msg.payload.ids)) return;
  const pl = msg.payload;
  if (pl.ids.length > 200) return;
  room.sb.__in = { owner: ws.slot, payload: {
    ids: pl.ids.filter((n) => Number.isInteger(n)), bx: +pl.bx, by: +pl.by,
    formMode: typeof pl.formMode === "string" ? pl.formMode : null,
    moveMode: pl.moveMode === "goto" ? "goto" : "atk",
    genMode: ["kiri", "kanan", "atas", "bawah", "tengah"].includes(pl.genMode) ? pl.genMode : "tengah",
  } };
  try { vm.runInContext(`mpApplyRemoteInput(__in.owner, {cmd:"orderMove", payload:__in.payload});`, room.sb); }
  catch (e) { console.error(`[room ${room.id}] ERROR input:`, e.message); }
}

// ---------- HTTP + WebSocket ----------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const list = [];
    for (const r of rooms.values()) {
      const s = r.stats;
      list.push({ id: r.id, mode: r.mode, teamSize: r.teamSize, state: r.state, players: playerCount(r),
        bots: r.bots.filter(Boolean).length, ticks: s.ticks,
        avgTickMs: s.ticks ? +(s.totalMs / s.ticks).toFixed(2) : 0, maxTickMs: +s.maxMs.toFixed(2), slowTicks: s.slow });
    }
    return res.end(JSON.stringify({ ok: true, activeRooms: activeRoomCount(), maxRooms: MAX_ROOMS, rooms: list }));
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Perang Strategi server OK\n");
});

// Kompresi per-pesan (permessage-deflate): snapshot JSON ~77% lebih kecil. Level rendah = hemat CPU server.
// Bisa dimatikan lewat env WS_COMPRESS=0 kalau CPU Railway terasa berat.
const COMPRESS = process.env.WS_COMPRESS !== "0";
const wss = new WebSocketServer({
  server,
  maxPayload: 2 * 1024 * 1024, // foto sudah dikecilkan client (~10 KB); batas longgar agar koneksi tidak diputus diam-diam
  perMessageDeflate: COMPRESS ? { zlibDeflateOptions: { level: 3 }, threshold: 512, serverNoContextTakeover: true, clientNoContextTakeover: true } : false,
});
wss.on("connection", (ws) => {
  ws.isAlive = true; ws.room = null; ws.slot = -1;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === "party") joinParty(ws, msg);
    else if (msg.type === "match") joinMatch(ws, msg);
    else if (msg.type === "input") handleInput(ws, msg);
    else if (msg.type === "cancel") leaveRoom(ws);
  });
  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => {});
});
setInterval(() => {                                                  // buang koneksi mati
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 20000);

// Log beban berkala per room (untuk menentukan MAX_ROOMS berdasarkan data nyata)
setInterval(() => {
  for (const r of rooms.values()) if (r.state === "playing" && r.stats.ticks) {
    const s = r.stats;
    console.log(`[room ${r.id}] tick avg ${(s.totalMs / s.ticks).toFixed(2)}ms max ${s.maxMs.toFixed(1)}ms lambat(>${SLOW_TICK_MS}ms) ${s.slow}/${s.ticks}`);
  }
}, 60000);

server.listen(PORT, () => console.log(`Server jalan di port ${PORT} | MAX_ROOMS=${MAX_ROOMS} tick=${TICK_HZ}Hz tunggu=${LOBBY_WAIT_MS}ms`));
