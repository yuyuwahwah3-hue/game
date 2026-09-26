(function(){

// ====== STATE DASAR ======
var isHost=false, peer=null, myId=null, myName="Pemain";
var conns=[]; // host: array koneksi ke tiap client
var hostConn=null; // client: koneksi tunggal ke host
var players={}; // id -> {name, color, x, y, joined}
var MAX_PLAYERS=4;
var COLORS=["#d4a832","#4488ff","#44c470","#c44040"];
var gameStarted=false;

var cv=document.getElementById("C"), cx=cv.getContext("2d");
function resize(){cv.width=innerWidth;cv.height=innerHeight}
resize(); window.onresize=resize;

// ====== LOBBY UI ======
var pNameInp=document.getElementById("pName");
var bHost=document.getElementById("bHost"), bJoin=document.getElementById("bJoin");
var joinCodeInp=document.getElementById("joinCode");
var hostBox=document.getElementById("hostBox"), roomCodeBox=document.getElementById("roomCodeBox");
var playerListEl=document.getElementById("playerList");
var bStartGame=document.getElementById("bStartGame");
var lobbyStatus=document.getElementById("lobbyStatus");
var lobbyEl=document.getElementById("lobby");
var tbEl=document.getElementById("tb");
var connDot=document.getElementById("connDot"), connText=document.getElementById("connText");
var endOv=document.getElementById("endOv"), endMsg=document.getElementById("endMsg");

function roomCode(){
 // 4 karakter A-Z0-9 gampang diketik & diucapkan
 var chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789",out="";
 for(var i=0;i<4;i++)out+=chars[Math.floor(Math.random()*chars.length)];
 return out;
}

function setStatus(t){lobbyStatus.textContent=t}

function renderPlayerList(){
 var html="";
 var i=0;
 for(var id in players){
  var p=players[id];
  html+='<div class="plItem"><span class="dot" style="background:'+p.color+'"></span>'+p.name+(id===myId?" (kamu)":"")+'</div>';
  i++;
 }
 playerListEl.innerHTML=html;
 bStartGame.style.display=(i>=1)?"block":"none"; // izinkan mulai sendirian saat testing; ganti >=2 utk produksi
}

// ====== HOST FLOW ======
bHost.onclick=function(){
 myName=(pNameInp.value||"Host").trim().slice(0,14)||"Host";
 isHost=true;
 var code=roomCode();
 setStatus("Menyambungkan ke server signaling...");
 peer=new Peer("warproto-"+code,{debug:1});

 peer.on("open",function(id){
  myId=id;
  players[id]={name:myName,color:COLORS[0],x:0,y:0};
  roomCodeBox.textContent=code;
  hostBox.style.display="flex";
  bHost.style.display="none";
  setStatus("Room dibuat. Bagikan kode ke teman.");
  renderPlayerList();
 });

 peer.on("connection",function(conn){
  if(conns.length>=MAX_PLAYERS-1){ conn.on("open",function(){conn.send({type:"full"});conn.close()}); return }
  conns.push(conn);
  conn.on("open",function(){
   // pemain baru akan kirim pesan "hello" berisi nama dia
  });
  conn.on("data",function(msg){ handleHostMessage(conn,msg) });
  conn.on("close",function(){ removePlayer(conn.peer) });
 });

 peer.on("error",function(err){ setStatus("Error: "+err.type) });
};

function removePlayer(id){
 delete players[id];
 for(var i=0;i<conns.length;i++) if(conns[i].peer===id) conns.splice(i,1);
 renderPlayerList();
 broadcastState();
}

function handleHostMessage(conn,msg){
 if(msg.type==="hello"){
  var idx=Object.keys(players).length;
  if(idx>=MAX_PLAYERS) return;
  players[conn.peer]={name:msg.name.slice(0,14),color:COLORS[idx],x:100+idx*40,y:100};
  renderPlayerList();
  broadcastState();
 } else if(msg.type==="input" && gameStarted){
  var p=players[conn.peer];
  if(p){ p.tx=msg.x; p.ty=msg.y; } // target posisi dari client, host yg gerakin
 }
}

function broadcastState(){
 var payload={type:"state",players:players};
 for(var i=0;i<conns.length;i++) conns[i].send(payload);
}

bStartGame.onclick=function(){
 gameStarted=true;
 broadcastToAll({type:"start"});
 enterGame();
};
function broadcastToAll(msg){ for(var i=0;i<conns.length;i++) conns[i].send(msg) }

// ====== CLIENT FLOW ======
bJoin.onclick=function(){
 myName=(pNameInp.value||"Pemain").trim().slice(0,14)||"Pemain";
 var code=(joinCodeInp.value||"").trim().toUpperCase();
 if(code.length!==4){ setStatus("Kode harus 4 karakter"); return }
 isHost=false;
 setStatus("Menyambung ke room "+code+"...");
 peer=new Peer(undefined,{debug:1});

 peer.on("open",function(id){
  myId=id;
  hostConn=peer.connect("warproto-"+code,{reliable:true});

  hostConn.on("open",function(){
   hostConn.send({type:"hello",name:myName});
   setStatus("Tersambung! Menunggu host mulai game...");
  });

  hostConn.on("data",function(msg){ handleClientMessage(msg) });

  hostConn.on("close",function(){
   showDisconnected("HOST TERPUTUS — GAME BERAKHIR");
  });

  hostConn.on("error",function(){
   setStatus("Gagal konek ke room. Cek kode & koneksi.");
  });
 });

 peer.on("error",function(err){
  if(err.type==="peer-unavailable") setStatus("Room tidak ditemukan. Cek kode.");
  else setStatus("Error: "+err.type);
 });
};

function handleClientMessage(msg){
 if(msg.type==="full"){ setStatus("Room penuh (maks 4 pemain)."); return }
 if(msg.type==="state"){ players=msg.players; if(document.getElementById("lobby").classList.contains("hd")===false && gameStartedClientSide) renderPlayerList(); }
 if(msg.type==="start"){ gameStarted=true; enterGame() }
}
var gameStartedClientSide=false;

function showDisconnected(text){
 endMsg.textContent=text;
 endOv.classList.remove("hd");
}
document.getElementById("bReload").onclick=function(){ location.reload() };

// ====== MASUK GAME (host & client sama-sama pakai render ini) ======
function enterGame(){
 lobbyEl.classList.add("hd");
 tbEl.classList.remove("hd");
 connDot.style.background = isHost ? "#4a9a4a" : "#4488ff";
 connText.textContent = isHost ? "kamu host" : "kamu client";
 requestAnimationFrame(loop);
}

// Input: tap/klik = kirim target posisi
cv.addEventListener("pointerdown",function(e){
 if(!gameStarted) return;
 var x=e.clientX,y=e.clientY;
 if(isHost){
  players[myId].tx=x; players[myId].ty=y;
 } else {
  hostConn.send({type:"input",x:x,y:y});
 }
});

// ====== SIMULASI (HANYA DI HOST) ======
var lastTick=0;
function hostSimTick(dt){
 for(var id in players){
  var p=players[id];
  if(p.tx==null) continue;
  var dx=p.tx-p.x, dy=p.ty-p.y, dist=Math.sqrt(dx*dx+dy*dy);
  var speed=220; // px/detik
  if(dist>4){
   p.x+=dx/dist*speed*dt;
   p.y+=dy/dist*speed*dt;
  }
 }
}

var BROADCAST_HZ=15; // kirim state ke client 15x/detik, bukan tiap frame — hemat bandwidth
var lastBroadcast=0;

function loop(t){
 var dt=Math.min((t-(lastTick||t))/1000,0.05);
 lastTick=t;

 if(isHost && gameStarted){
  hostSimTick(dt);
  if(t-lastBroadcast>1000/BROADCAST_HZ){ broadcastState(); lastBroadcast=t }
 }

 render();
 requestAnimationFrame(loop);
}

function render(){
 cx.clearRect(0,0,cv.width,cv.height);
 cx.fillStyle="#1a1c10";
 for(var gx=0;gx<cv.width;gx+=40) cx.fillRect(gx,0,1,cv.height);
 for(var gy=0;gy<cv.height;gy+=40) cx.fillRect(0,gy,cv.width,1);

 for(var id in players){
  var p=players[id];
  cx.beginPath();
  cx.arc(p.x,p.y,16,0,Math.PI*2);
  cx.fillStyle=p.color;
  cx.fill();
  cx.strokeStyle=(id===myId)?"#fff":"rgba(0,0,0,.4)";
  cx.lineWidth=(id===myId)?2.5:1;
  cx.stroke();

  cx.font="bold 11px monospace";
  cx.textAlign="center";
  cx.lineWidth=3; cx.strokeStyle="#000";
  cx.strokeText(p.name,p.x,p.y-24);
  cx.fillStyle="#fff";
  cx.fillText(p.name,p.x,p.y-24);
 }

 cx.fillStyle="#8a8060";
 cx.font="10px monospace";
 cx.textAlign="left";
 cx.fillText("Tap/klik di mana saja untuk gerakkan kotak kamu",10,cv.height-14);
}

})();