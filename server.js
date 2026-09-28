"use strict";
/*
 * Perang Strategi - Server multiplayer (Railway)
 *
 * - Matchmaking otomatis: pemain kirim "find", masuk room lobby yg masih punya slot (atau dibuat baru).
 * - Room mulai otomatis: penuh (4) = langsung; kalau tidak, LOBBY_WAIT_MS sejak pemain pertama masuk
 *   (solo boleh).
 * - Room yg sudah mulai tidak menerima pemain baru.
 * - Tiap room = 1 VM terpisah berisi kode simulasi game asli (sim.js), jadi state global tidak bocor.
 * - Server yg authoritative: client hanya kirim input, slot (owner) ditentukan server dari koneksi.
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
const MAX_PLAYERS = 4;
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
let nextRoomId = 1;
const rooms = new Map();          // id -> room
let waitingRoom = null;           // room lobby yg masih menerima pemain

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) {
  const data = JSON.stringify(obj);
  for (const c of room.clients) if (c && c.readyState === 1) c.send(data);
}
function activeRoomCount() { let n = 0; for (const r of rooms.values()) if (r.state === "playing") n++; return n; }

function createRoom() {
  const room = {
    id: nextRoomId++, state: "lobby", clients: [null, null, null, null], players: [null, null, null, null],
    createdAt: Date.now(), startTimer: null, tickTimer: null, tickN: 0, sb: null,
    stats: { ticks: 0, totalMs: 0, maxMs: 0, slow: 0 },
  };
  rooms.set(room.id, room);
  return room;
}
function playerCount(room) { return room.players.filter(Boolean).length; }
function lobbyInfo(room) {
  return { type: "lobby", room: room.id, players: room.players.map((p) => p && { name: p.name, photo: p.photo }),
    startsInMs: room.startTimer ? Math.max(0, room.startAt - Date.now()) : null };
}

function joinMatchmaking(ws, msg) {
  if (ws.room) return;
  let room = waitingRoom && waitingRoom.state === "lobby" && playerCount(waitingRoom) < MAX_PLAYERS ? waitingRoom : null;
  if (!room) {
    if (activeRoomCount() + (waitingRoom && waitingRoom.state === "lobby" ? 1 : 0) >= MAX_ROOMS && !waitingRoom) {
      return send(ws, { type: "busy", message: "Server penuh, coba lagi sebentar lagi." });
    }
    room = createRoom();
    waitingRoom = room;
  }
  const slot = room.clients.findIndex((c) => !c);
  room.clients[slot] = ws;
  room.players[slot] = { name: String(msg.name || "Jenderal").slice(0, 20), photo: typeof msg.photo === "string" && msg.photo.length < 400000 ? msg.photo : null };
  ws.room = room; ws.slot = slot;
  send(ws, { type: "assignOwner", owner: slot, room: room.id });

  if (playerCount(room) === 1) {
    room.startAt = Date.now() + LOBBY_WAIT_MS;
    room.startTimer = setTimeout(() => startRoom(room), LOBBY_WAIT_MS);
  }
  broadcast(room, lobbyInfo(room));
  if (playerCount(room) >= MAX_PLAYERS) startRoom(room);            // penuh = langsung mulai
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients[ws.slot] = null;
  if (room.state === "lobby") {
    room.players[ws.slot] = null;
    if (playerCount(room) === 0) destroyRoom(room);
    else broadcast(room, lobbyInfo(room));
  } else if (room.state === "playing") {
    // Pemain keluar di tengah game: bidaknya tetap ada (jadi diam). Jika semua pemain keluar, room ditutup.
    if (room.clients.every((c) => !c)) destroyRoom(room);
  }
  ws.room = null;
}

function destroyRoom(room) {
  clearTimeout(room.startTimer); clearInterval(room.tickTimer);
  room.state = "closed"; room.sb = null; rooms.delete(room.id);
  if (waitingRoom === room) waitingRoom = null;
}

function startRoom(room) {
  if (room.state !== "lobby") return;
  clearTimeout(room.startTimer);
  if (waitingRoom === room) waitingRoom = null;                     // room ini tidak lagi menerima pemain baru
  room.state = "playing";

  const sb = makeSandbox(room);
  vm.createContext(sb);
  SIM_SCRIPT.runInContext(sb);
  room.sb = sb;
  // tK (toast) dari game dibelokkan ke antrean, dikirim bersama snapshot
  vm.runInContext(`tK = function(m){ __toasts.push(String(m)); };`, sb);
  sb.__players = room.players;
  vm.runInContext(`
    mpIsHost = true; mpMyOwner = 0; mpGameStarted = true;
    for (var i=0;i<4;i++) mpPlayers[i] = __players[i] ? {name:__players[i].name, photo:null} : null;
    mpEnterGame();
  `, sb);

  broadcast(room, { type: "start", room: room.id, players: room.players.map((p) => p && { name: p.name, photo: p.photo }) });

  const dt = 1 / TICK_HZ;
  room.tickTimer = setInterval(() => tickRoom(room, dt), 1000 / TICK_HZ);
  console.log(`[room ${room.id}] MULAI dengan ${playerCount(room)} pemain. Room aktif: ${activeRoomCount()}`);
}

function tickRoom(room, dt) {
  if (room.state !== "playing" || !room.sb) return;
  const t0 = process.hrtime.bigint();
  try {
    vm.runInContext(`update(${dt})`, room.sb);
  } catch (e) {
    console.error(`[room ${room.id}] ERROR update:`, e.message);
    broadcast(room, { type: "end", reason: "ERROR SERVER — PERANG BERAKHIR" });
    return destroyRoom(room);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const s = room.stats; s.ticks++; s.totalMs += ms; if (ms > s.maxMs) s.maxMs = ms; if (ms > SLOW_TICK_MS) s.slow++;

  room.tickN++;
  if (room.tickN % SNAP_EVERY === 0) sendSnapshot(room);

  const over = vm.runInContext("go", room.sb);
  if (over && !room.endSent) {
    room.endSent = true;
    const win = vm.runInContext("pc.every(function(p){return p.t!=='e'||!p.al})", room.sb);
    broadcast(room, { type: "end", reason: win ? "KEMENANGAN!" : "KEKALAHAN TOTAL — semua jenderal gugur" });
    setTimeout(() => destroyRoom(room), 3000);
  }
}

// Snapshot ringkas: hanya field yg dibutuhkan render. Bidak musuh yg mati/tersembunyi tidak dikirim.
function sendSnapshot(room) {
  const snap = vm.runInContext(`(function(){
    var out=[], ids=[];
    for (var i=0;i<pc.length;i++){
      var p=pc[i];
      if(!p.al||p.hidden) continue;
      ids.push(i);
      out.push([Math.round(p.x*10)/10, Math.round(p.y*10)/10, Math.round(p.a*100)/100, p.t==='p'?1:0, p.i, Math.round(p.hp), Math.round(p.mhp), p.gen?1:0, p.owner|0, p.hf>0?1:0, p.ord?1:0]);
    }
    var t=[]; for (var k=0;k<tr.length;k++) t.push(tr[k].tm==='p'?1:0);
    var pa=0; for (var j=0;j<pc.length;j++) if(pc[j].al&&pc[j].t==='p') pa++;
    var cp=0; for (var q=0;q<tr.length;q++) if(tr[q].tm==='p') cp++;
    var gens=[]; for (var o=0;o<4;o++){ var g=pgens[o]; gens.push(g?[g.al?1:0, Math.round(g.hp/g.mhp*100), pc.indexOf(g)]:null); }
    var rs=[]; for (var r=0;r<4;r++) rs.push(mpRespawnTimers[r]?Math.max(0,Math.round((mpRespawnTimers[r]-performance.now())/1000)):0);
    return {ids:ids, p:out, t:t, pa:pa, cp:cp, gens:gens, rs:rs, min:Math.floor((performance.now()-mpGameStartTime)/60000)};
  })()`, room.sb);
  snap.type = "state";
  const toasts = room.sb.__toasts; if (toasts.length) { snap.toasts = toasts.splice(0, toasts.length); }
  broadcast(room, snap);
}

function handleInput(ws, msg) {
  const room = ws.room;
  if (!room || room.state !== "playing" || !room.sb) return;
  if (msg.cmd !== "orderMove" || !msg.payload || !Array.isArray(msg.payload.ids)) return;
  const pl = msg.payload;
  if (pl.ids.length > 200) return;                                  // batasi ukuran perintah
  // owner ditentukan SERVER dari koneksi (ws.slot), bukan dari isi pesan
  room.sb.__in = { owner: ws.slot, payload: {
    ids: pl.ids.filter((n) => Number.isInteger(n)), bx: +pl.bx, by: +pl.by,
    formMode: typeof pl.formMode === "string" ? pl.formMode : null,
    moveMode: pl.moveMode === "goto" ? "goto" : "atk",
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
      list.push({ id: r.id, state: r.state, players: playerCount(r), ticks: s.ticks,
        avgTickMs: s.ticks ? +(s.totalMs / s.ticks).toFixed(2) : 0, maxTickMs: +s.maxMs.toFixed(2), slowTicks: s.slow });
    }
    return res.end(JSON.stringify({ ok: true, activeRooms: activeRoomCount(), maxRooms: MAX_ROOMS, rooms: list }));
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Perang Strategi server OK\n");
});

const wss = new WebSocketServer({ server, maxPayload: 600 * 1024 });
wss.on("connection", (ws) => {
  ws.isAlive = true; ws.room = null; ws.slot = -1;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === "find") joinMatchmaking(ws, msg);
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
