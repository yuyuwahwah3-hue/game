

(function(){
 var wrap=document.getElementById("ppWrap"),fileInp=document.getElementById("ppFile"),imgEl=document.getElementById("ppImg"),ph=document.getElementById("ppPh");
 var nameInp=document.getElementById("pName"),cnt=document.getElementById("pNameCnt");
 wrap.onclick=function(){fileInp.click()};
 fileInp.onchange=function(){
  var f=fileInp.files&&fileInp.files[0];if(!f)return;
  var rd=new FileReader();
  rd.onload=function(){
   var im=new Image();
   im.onload=function(){playerPhotoImg=im;playerPhotoDataURL=rd.result};
   im.src=rd.result;
   imgEl.src=rd.result;imgEl.style.display="block";ph.style.display="none";
  };
  rd.readAsDataURL(f);
 };
 nameInp.oninput=function(){
  if(nameInp.value.length>20)nameInp.value=nameInp.value.slice(0,20);
  cnt.textContent=nameInp.value.length+"/20";
 };
 nameInp.onchange=function(){ playerName=(nameInp.value||"").trim().slice(0,20)||"Jenderal" };

 // ====== MULTIPLAYER LOBBY (host/join room via PeerJS, 4 slot) ======
 var bHost=document.getElementById("bMpHost"),bJoin=document.getElementById("bMpJoin");
 var joinCodeInp=document.getElementById("mpJoinCode");
 var hostBox=document.getElementById("mpHostBox"),roomCodeBox=document.getElementById("mpRoomCode");
 var playerListEl=document.getElementById("mpPlayerList"),bStart=document.getElementById("bMpStart");
 var statusEl=document.getElementById("mpStatus");

 function setStatus(t){statusEl.textContent=t}
 function roomCode(){var c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789",o="";for(var i=0;i<4;i++)o+=c[Math.floor(Math.random()*c.length)];return o}
 function curName(){ return (nameInp.value||"").trim().slice(0,20)||"Jenderal" }

 function renderPlayerList(){
  var html="",n=0;
  for(var i=0;i<4;i++){
   var pl=mpPlayers[i];
   if(!pl)continue;
   n++;
   html+='<div class="mpPlItem"><span class="mpDot" style="background:'+OWNER_COLORS[i]+'"></span>'+pl.name+(i===mpMyOwner?" (kamu)":"")+'</div>';
  }
  playerListEl.innerHTML=html;
  bStart.style.display=(n>=1)?"block":"none";
 }

 bHost.onclick=function(){
  playerName=curName();
  mpIsHost=true;mpMyOwner=0;
  var code=roomCode();
  setStatus("Menyambungkan ke server signaling...");
  mpPeer=new Peer("warstrat-"+code,{debug:1});
  mpPeer.on("open",function(id){
   mpPlayers[0]={name:playerName,photo:playerPhotoDataURL};
   roomCodeBox.textContent=code;
   hostBox.style.display="flex";
   bHost.style.display="none";
   setStatus("Room dibuat. Bagikan kode ke 3 teman.");
   renderPlayerList();
  });
  mpPeer.on("connection",function(conn){
   var freeSlot=-1;
   for(var i=1;i<4;i++)if(!mpPlayers[i]){freeSlot=i;break}
   if(freeSlot===-1){ conn.on("open",function(){conn.send({type:"full"});conn.close()}); return }
   mpConns[freeSlot]=conn;
   conn.on("data",function(msg){ mpHandleHostMessage(freeSlot,conn,msg) });
   conn.on("close",function(){ mpPlayers[freeSlot]=null;mpConns[freeSlot]=null;renderPlayerList();mpBroadcastLobby() });
  });
  mpPeer.on("error",function(err){ setStatus("Error: "+err.type) });
 };

 bStart.onclick=function(){
  mpGameStarted=true;
  mpBroadcast({type:"start",players:mpPlayers});
  document.getElementById("ov").classList.add("hd");
  mpEnterGame();
 };

 bJoin.onclick=function(){
  playerName=curName();
  var code=(joinCodeInp.value||"").trim().toUpperCase();
  if(code.length!==4){ setStatus("Kode harus 4 karakter"); return }
  mpIsHost=false;
  setStatus("Menyambung ke room "+code+"...");
  mpPeer=new Peer(undefined,{debug:1});
  mpPeer.on("open",function(id){
   mpHostConn=mpPeer.connect("warstrat-"+code,{reliable:true});
   mpHostConn.on("open",function(){
    mpHostConn.send({type:"hello",name:playerName,photo:playerPhotoDataURL});
    setStatus("Tersambung! Menunggu host mulai perang...");
   });
   mpHostConn.on("data",function(msg){ mpHandleClientMessage(msg) });
   mpHostConn.on("close",function(){ mpShowDisconnected() });
   mpHostConn.on("error",function(){ setStatus("Gagal konek. Cek kode & koneksi.") });
  });
  mpPeer.on("error",function(err){
   if(err.type==="peer-unavailable") setStatus("Room tidak ditemukan. Cek kode.");
   else setStatus("Error: "+err.type);
  });
 };

 window.mpRenderLobbyList=renderPlayerList;
 window.mpSetStatus=setStatus;
})();

