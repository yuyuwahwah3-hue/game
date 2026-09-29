

// KONFIG

var BW=16800,BH=9108,PR=9,SR=34,ORB=82.5,AR=180,MS=50,DR=26,FH=Math.PI*0.42;
var BORDER=390; // ketebalan penghalang batu di tepi map (dlm unit dunia)
var GEN_SIGHT=1000; // jarak pandang jendral pemain (unit dunia) - bidak/musuh yg lebih jauh dari ini
// dari jendral TIDAK DIGAMBAR (tak terlihat di layar, termasu musuh yg sedang dilawan), tapi simulasi
// (gerak/perang/spawn musuh) tetap jalan normal spt biasa - pertempuran terjadi "di belakang layar"
// tanpa sepengetahuan jendral. Bidak yg tersembunyi ini tetap bisa dipilih (drag-select pakai koordinat
// dunia, tak peduli tergambar atau tidak) & tetap bisa diperintah gerak spt biasa.
var playerName="Jenderal",playerPhotoImg=null,playerPhotoDataURL=null; // nama & foto profil jendral pemain, diisi dari halaman awal (#ov)

// ====== MULTIPLAYER (host-authoritative P2P via PeerJS) ======
// owner: 0-3, indeks slot pemain. mpMyOwner = slot pemain LOKAL (browser ini).
// Host (owner 0) menjalankan simulasi penuh (update/AI/fisika) & broadcast state ke semua client.
// Client cuma kirim perintah (klik/drag/formasi) ke host & render state yg diterima.
var OWNER_COLORS=["#d4a832","#4488ff","#44c470","#a86633"]; // kuning, biru, hijau, coklat (bukan merah - sama dgn warna musuh)
var OWNER_NAMES=["Jenderal 1","Jenderal 2","Jenderal 3","Jenderal 4"];
var mpIsHost=false,mpPeer=null,mpMyOwner=0,mpGameStarted=false;
var mpConns=[null,null,null,null]; // host: koneksi ke tiap client (indeks by owner)
var mpHostConn=null; // client: koneksi tunggal ke host
var mpPlayers=[null,null,null,null]; // {name,photo} per owner slot
var mpPhotoImgs=[null,null,null,null]; // Image() per owner, dipakai render jenderal masing2
var mpGameStartTime=0; // performance.now() saat mpEnterGame() dipanggil, dasar hitung waktu respawn
var mpRespawnTimers=[0,0,0,0]; // epoch ms kapan owner boleh respawn (0 = tidak sedang menunggu)
var mpEnded=false;

function mpRespawnOwner(ownerIdx){
 // Bidak lama owner ini TIDAK di-splice (menghapus elemen menggeser semua indeks pc, padahal
 // banyak state menyimpan indeks: sel, pgenIdxBase owner lain, dll). Cukup tandai mati/tak tampil,
 // lalu spawn 25 bidak+jendral baru di akhir array pc di markas asal owner (OWNER_HOME).
 for(var qi=0;qi<pc.length;qi++){
  var o=pc[qi];
  if(o.owner===ownerIdx&&o.t==="p"&&o.al){o.al=false;o.hp=0}
 }
 var home=OWNER_HOME[ownerIdx]||{x:1400,y:2243};
 spawnOwnerGroup(ownerIdx,home.x,home.y);
 if(ownerIdx===mpMyOwner){ pgenIdx=pgenIdxBase[mpMyOwner];pgen=pc[pgenIdx]; sel.clear();uSI(); }
 __respQ.push(ownerIdx);
}

function mpRespawnDelaySec(){
 // menit_ke_berapa_game_berjalan x 5 detik (menit1=5s, menit5=25s), dibatasi maks 120s
 var minutes=(performance.now()-mpGameStartTime)/60000;
 return Math.min(120,Math.max(5,minutes*5));
}

function mpBroadcast(msg){ for(var i=0;i<4;i++) if(mpConns[i]) mpConns[i].send(msg) }
function mpBroadcastLobby(){ mpBroadcast({type:"lobby",players:mpPlayers}) }

// ====== SINKRONISASI STATE (host -> client) ======
// Host mengirim snapshot ringkas array pc & tr tiap beberapa frame (bukan tiap frame, utk hemat
// bandwidth). Client TIDAK simulasi sendiri (lihat gl()), cuma timpa pc/tr lokal dgn data ini.
var MP_BROADCAST_HZ=12;
var mpLastBroadcastT=0;

function mpSerializePc(){
 // Kirim field minimal yg dibutuhkan utk render+HUD, bukan seluruh object (banyak field internal
 // AI/physics yg cuma relevan utk host, tak perlu dikirim - hemat bandwidth signifikan).
 var out=new Array(pc.length);
 for(var i=0;i<pc.length;i++){
  var p=pc[i];
  out[i]=[p.x,p.y,p.a,p.t,p.i,p.hp,p.mhp,p.gen?1:0,p.al?1:0,p.hidden?1:0,p.owner,p.hf,p.ord||"",p.tgt?1:0,p.orbiting?1:0,p.rt?1:0,p.obey?1:0];
 }
 return out;
}
function mpDeserializePc(arr){
 // Rekonstruksi objek pc dari data ringkas host. Field yg tak dikirim (internal AI dll) diisi default
 // aman krn client tak pernah menjalankan simulasi/AI thd objek ini (cuma dipakai utk render & seleksi).
 var out=new Array(arr.length);
 for(var i=0;i<arr.length;i++){
  var a=arr[i];
  out[i]={x:a[0],y:a[1],a:a[2],t:a[3],i:a[4],hp:a[5],mhp:a[6],gen:!!a[7],al:!!a[8],hidden:!!a[9],owner:a[10],hf:a[11],ord:a[12]||null,tgt:a[13]?true:null,orbiting:a[14]?true:null,rt:!!a[15],obey:!!a[16],form:null,formAng:0};
 }
 return out;
}
function mpSerializeTr(){
 var out=new Array(tr.length);
 for(var i=0;i<tr.length;i++){var te=tr[i];out[i]=[te.tm,te.st||""]}
 return out;
}
function mpApplyTrLite(arr){
 for(var i=0;i<arr.length&&i<tr.length;i++){tr[i].tm=arr[i][0];tr[i].st=arr[i][1]||tr[i].st}
}

function mpTickBroadcast(t){
 if(t-mpLastBroadcastT<1000/MP_BROADCAST_HZ)return;
 mpLastBroadcastT=t;
 var pa=0;for(var i=0;i<pc.length;i++)if(pc[i].al&&pc[i].t==="p")pa++;
 var cp=0;for(var i=0;i<tr.length;i++)if(tr[i].tm==="p")cp++;
 mpBroadcast({
  type:"state",
  pc:mpSerializePc(),
  tr:mpSerializeTr(),
  pa:pa,
  hudGH:pgens[0]?Math.max(0,Math.round((pgens[0].hp/pgens[0].mhp)*100)):0, // dikirim per-owner di bawah, ini fallback
  gensHp:[0,1,2,3].map(function(oi){var g=pgens[oi];return g?Math.round(g.hp/g.mhp*100):0}),
  gensAl:[0,1,2,3].map(function(oi){var g=pgens[oi];return g?g.al:false}),
  cp:cp,
  go:go
 });
}

function mpApplyHostState(msg){
 pc=mpDeserializePc(msg.pc);
 mpApplyTrLite(msg.tr);
 for(var oi=0;oi<4;oi++){
  pgens[oi]=null;
  // Ambil jendral TERBARU milik owner ini (iterasi dari belakang): setelah respawn, jendral lama yg
  // sudah mati masih ada di array (tdk di-splice), jadi jendral baru selalu ada di indeks lebih besar.
  for(var qi=pc.length-1;qi>=0;qi--){if(pc[qi].owner===oi&&pc[qi].gen&&pc[qi].t==="p"){pgens[oi]=pc[qi];break}}
 }
 pgen=pgens[mpMyOwner];
 document.getElementById("pC").textContent=msg.pa;
 document.getElementById("tC").textContent=msg.cp+"/20";
 if(pgen)document.getElementById("gH").textContent=msg.gensHp[mpMyOwner];
 if(msg.go&&!mpEnded){ mpShowGameEnd(msg.pa===0?"KEKALAHAN TOTAL":"KEMENANGAN!") }
}

// ====== INPUT (client -> host) ======
// Client mengirim perintah gerak/serang/formasi milik bidak DIA SENDIRI (owner===mpMyOwner) ke host;
// host yg mengeksekusi perintah itu thd pc lokal-nya (authoritative). Host sendiri (owner 0) langsung
// eksekusi perintah lokal tanpa lewat network (lihat pemanggilan mpSendOrApplyInput di handler klik).
function mpSendOrApplyInput(cmdType,payload){
 if(mpIsHost){
  mpApplyRemoteInput(mpMyOwner,{cmd:cmdType,payload:payload});
 } else if(mpHostConn){
  mpHostConn.send({type:"input",cmd:cmdType,payload:payload});
 }
}
function mpApplyRemoteInput(ownerIdx,msg){
 // msg: {cmd,payload}. Cuma berlaku thd bidak milik ownerIdx tsb (dicek ulang di sisi host demi keamanan
 // dasar - client nakal secara teori bisa kirim ownerIdx palsu, tp krn ownerIdx diambil dari koneksi
 // conn yg sudah terikat slot saat handshake di mpHandleHostMessage, bukan dari isi pesan, ini aman).
 if(msg.cmd==="orderMove"){
  var pl=msg.payload;
  var savedSel=sel,savedFormMode=formMode,savedMoveMode=moveMode;
  sel=new Set();
  for(var k=0;k<pl.ids.length;k++){
   var p=pc[pl.ids[k]];
   if(p&&p.owner===ownerIdx&&p.t==="p")sel.add(pl.ids[k]);
  }
  formMode=pl.formMode;moveMode=pl.moveMode;
  __cmdOwner=ownerIdx;__cmdGenMode=pl.genMode;
  if(sel.size>0)orderMove(pl.bx,pl.by);
  __cmdOwner=undefined;__cmdGenMode=undefined;
  sel=savedSel;formMode=savedFormMode;moveMode=savedMoveMode;
 }
}

function mpLoadPhotoImgs(){
 for(var i=0;i<4;i++){
  var pl=mpPlayers[i];
  if(pl&&pl.photo&&!mpPhotoImgs[i]){
   var im=new Image();im.src=pl.photo;mpPhotoImgs[i]=im;
  } else if(!pl){ mpPhotoImgs[i]=null }
 }
}

function mpHandleHostMessage(ownerIdx,conn,msg){
 if(msg.type==="hello"){
  mpPlayers[ownerIdx]={name:msg.name.slice(0,20),photo:msg.photo};
  mpLoadPhotoImgs();
  conn.send({type:"assignOwner",owner:ownerIdx}); // KRUSIAL: beri tahu client ini dia dpt slot ke berapa
  if(window.mpRenderLobbyList)window.mpRenderLobbyList();
  mpBroadcastLobby();
 } else if(msg.type==="input" && mpGameStarted){
  mpApplyRemoteInput(ownerIdx,msg);
 }
}
function mpHandleClientMessage(msg){
 if(msg.type==="full"){ if(window.mpSetStatus)window.mpSetStatus("Room penuh (maks 4 pemain)."); return }
 if(msg.type==="assignOwner"){ mpMyOwner=msg.owner; if(window.mpRenderLobbyList)window.mpRenderLobbyList(); }
 if(msg.type==="lobby"){ mpPlayers=msg.players;mpLoadPhotoImgs(); if(window.mpRenderLobbyList)window.mpRenderLobbyList(); }
 if(msg.type==="start"){
  mpPlayers=msg.players;mpGameStarted=true;mpLoadPhotoImgs();
  document.getElementById("ov").classList.add("hd");
  mpEnterGame();
 }
 if(msg.type==="state"){ mpApplyHostState(msg) }
 if(msg.type==="end"){ mpShowGameEnd(msg.reason) }
}
function mpShowDisconnected(){
 mpEnded=true;
 var ov=document.getElementById("mpEndOv");
 if(ov){ document.getElementById("mpEndMsg").textContent="HOST TERPUTUS — PERANG BERAKHIR"; ov.classList.remove("hd"); }
}
function mpShowGameEnd(reason){
 mpEnded=true;
 var ov=document.getElementById("mpEndOv");
 if(ov){ document.getElementById("mpEndMsg").textContent=reason||"PERANG BERAKHIR"; ov.classList.remove("hd"); }
}

// PETA LATAR (gambar acuan dunia nyata, dipakai sbg background & acuan bentuk wilayah)
var bgImg=new Image();
var bgReady=false;
bgImg.onload=function(){bgReady=true;mcDirty=true};
bgImg.src="";

// GRID AIR (laut/danau) diambil dari warna biru pada gambar peta, dipakai utk melambatkan bidak yg berenang
var WATER_COLS=168,WATER_ROWS=92,WATER_CELL=100,WATER_SPD=0.4;
var WATER_B64="//////8DAAAAAAAAAAAAAAAAAAAA//////8DAAAAAAAAAAAAAAAAAAAA//////8DAAAAAAAAAAAAAAAAAAAA//////8HAAAAAAAAAAAAAAAAAAAA//////8HAAAAAAAAAAAAAAAAAAAA//////8fAAAAAAAAAAAAAAAAAAAA//////8fAAAAAAAAAAAAAAAAAAAA//////8PAAAAAAAAAAAAAAAAAAAA//////8fAAAAAAAAAAAAAAAAAAAA//////9//gAAAAAAAAAAAAAAAAAA///////v8wAAAAAAAAAAAAAAAAAA//////9DgAAAAAAAAAAAAAAAAAAA//////8DAAAAAAAAAAAAAAAAAAAA//////8DAAAAAAAAAAAAAAAAAAAA////f/8DAAAAAAAAAAAAAAAAAAAA//+/A4cBAAAAAAAAAAAAAAAAAAAA//8PAAQAAAAAAAAAAAAAAAAAAAAA//8BAAAAAAAAAAAAAAAAAAAAAAAA/38AAAAAAAAAAAAAAAAAAAAAAAAA/x8AAAAAAAAAAAAAAAAAAAAAAAAA/w8AAAAAAAAAAAAAAAAAAAAAAAAA/w8AAAAAAAAAAAAAAAAAAAAAAAAAnw8AAAAAAAAAAAAAAAAAAAAAAAAA/wcAAAAAAAAAAAAAAAAAAAAAAAAA/wcAAAAAAAAAAAAAAAAAAAAAAAAA/w0AAAAAAAAAAAAAAAAAAAAAAAAA/wcMAAAAAAAAAAAAAAAAAAAAAAAA/+cHAAAAAAAAAAAAAAAAAAAAAAAA/+cGAAAAAAAAAAAAAAAAAAAAAAAA/+d+AAAAAAAAAAAAAAAAAAAAAAAA/28AAAAAAAAAAAAAAAAAAAAAAAAA/88AAAAAAAAAAAAAAAAAAAAAAAAA/98EAAAAAAAAAAAAAAAAAAAAAAAA/98+AAAAAAAAAAAAAAAAAAAAAAAA//8/AAAAAAAAAAAAAAAAAAAAAAAA//8/AAAAAAAAAAAAAAAAAAAAAAAA//8gAAAAAAAAAAAAAAAAAAAAAAAA/w8AAAAAAAAAAAAAAAAAAAAAAAAA/wUAAAAAAAAAAAAAAAAAAAAAAAAA/x8AAAAAAAAAAAAAAAAAAAAAAAAA//8AAAAAAAAAAAAAAAAAAAAAAAAA//8BAAAAAAAAAAAAAAAAAAAAAAAA/38DAAAAAAAAAAAAAAAAAAAAAAAA//8HAAAAAAAAAAAAAAAAAAAAAAAA/48HAAAAAAAAAAAAAAAAAAAAAAAA/78HEwAAAAAAAAAAAAAAAAAAAAAA/z8HNwAAAAAAAAAAAAAAAAAAAAAA/3+CPQAAAAAAAAAAAAAAAAAAAAAA/3/8fwAAAAAAAAAAAAAAAAAAAAAA///8/w8AAAAAAAAAAAAAAAAAAAAA/////z8AAAAAAAAAAAAAAAAAAAAA/////38AAAAAAAAAAAAAAAAAAAAA//////8BAAAAAAAAAAAAAAAAAAAA//////8PAAAAAAAAAAAAAAAAAAAA/////z8fAAAAAAAAAAAAAAAAAAAA//////8/gAAAAAAAAAAAAAAAAAAA//////8/8AEAAAAAAAAAAAAAAAAA//////+/zwAAAAAAAAAAAAAAAAAA//+P//+/HwAAAAAAAAAAAAAAAAAA///w//+/P34AAAAAAAAAAAAAAAAA////////4D4AAAAAAAAAAAAAAAAA//////9/gj0AAAAAAAAAAAAAAAAA//////8ngw8AAAAAAAAAAAAAAAAA//////9Hvw8AAAAAAAAAAAAAAAAA//////+H7w8AAAAAAAAAAAAAAAAA//////8P/w8AAAAAAAAAAAAAAAAA/////////wsAAAAAAAAAAAAAAAAA//////////cMAAAAAAAAAAAAAAAA//////////8PAAAAAAAAAAAAAAAA//////////EPAAAAAAAAAAAAAAAA/////////4MHAAAAAAAAAAAAAAAA/////////4cHAAAAAAAAAAAAAAAA/////////49/AAAAAAAAAAAAAAAA/////////8//AAAAAAAAAAAAAAAA/////////995AAAAAAAAAAAAAAAA/////////995AAAAAAAAAAAAAAAA//////////8xAAAAAAAAAAAAAAAA//////////8fAAAAAAAAAAAAAAAA//////////8PAAAAAAAAAAAAAAAA//////////8PAAAAAAAAAAAAAAAA//////////8PAAAAAAAAAAAAAAAA//////////8fAAAAAAAAAAAAAAAA//////////8/AAAAAAAAAAAAAAAA/////////x9/AAAAAAAAAAAAAAAA/////////19+AAAAAAAAAAAAAAAA///////////PAAAAAAAAAAAAAAAA////////////AQAAAAAAAAAAAAAA////////////AQAAAAAAAAAAAAAA//////////+fAQAAAAAAAAAAAAAA////////////AwAAAAAAAAAAAAAA////////////AQAAAAAAAAAAAAAA////////////AQAAAAAAAAAAAAAA";
var waterGrid=(function(){
 var bin=atob(WATER_B64),by=new Uint8Array(bin.length);
 for(var i=0;i<bin.length;i++)by[i]=bin.charCodeAt(i);
 return by;
})();
function isWater(x,y){
 var gx=Math.floor(x/WATER_CELL),gy=Math.floor(y/WATER_CELL);
 if(gx<0||gy<0||gx>=WATER_COLS||gy>=WATER_ROWS)return false;
 var bitIdx=gy*WATER_COLS+gx,byteV=waterGrid[bitIdx>>3];
 return ((byteV>>(bitIdx&7))&1)===1;
}

// LABEL LAUT: hanya nama tempel di atas perairan, BUKAN wilayah yg bisa ditaklukkan (tidak ada poligon/musuh/capture)
var seaLabels=[
 {nm:"Sagara Kidul",x:500,y:7400,sz:1.15},
 {nm:"Sagara Amarah",x:500,y:3700,sz:1.0},
 {nm:"Sagara Kalapa",x:600,y:1700,sz:1.0},
 {nm:"Palung Sancang",x:150,y:7000,sz:0.9},
 {nm:"Selat Jaladri",x:2800,y:6900,sz:0.85},
 {nm:"Teluk Layung",x:1900,y:5200,sz:0.85},
 {nm:"Segara Anakan",x:1200,y:3300,sz:0.85},
 {nm:"Leuwi Buaya",x:3800,y:6650,sz:0.85},
 {nm:"Perairan Nusa Papak",x:3400,y:5900,sz:0.85},
 {nm:"Muara Jati",x:4500,y:900,sz:0.85}
];

// SR = jangkauan "pedang" (sword reach) - ujung arah hadap penyerang harus sejauh ini agar bisa mengenai zona musuh
// ORB = radius orbit saat flanking (memutari musuh tanpa mendekat sebelum posisi ada di zona belakang)
var RSR=SR*1.15; // radius deteksi mundur (di ujung jangkauan pedang) - 2 penyerang depan terdeteksi disini memicu mundur SEBELUM masuk radius damage penuh, memberi ruang agar tak kena hit
var BDR=ORB*1.15; // radius deteksi "sudah di belakang musuh" - dipakai utk backstab prioritas walau blm terkunci sbg target
// Mode gerak bidak (toggle tiap kali diberi perintah tap): ganjil=mode SERANG (boleh auto-target musuh sambil jalan),
// genap=mode IKUT PERINTAH (jalan mutlak ke titik tujuan, tak pernah auto-target/backstab, sampai diperintah lagi)



// STATE

var pc=[],tr=[],pt=[],rocks=[],sel=new Set(),drag=null;
var wilTimer=0,mmTimer=0; // throttle timer utk cek wilayah & redraw minimap (optimasi performa)

var gidCount={};
var __cmdOwner,__cmdGenMode;
var __warnQ=[];
var __deathQ=[];
var __respQ=[]; // owner yg baru respawn // owner yg jenderalnya baru gugur (mulai timer respawn)
var pgen=null,pgenIdx=22; // jenderal pemain LOKAL (owner===mpMyOwner) - dipakai apa adanya oleh AI/HUD/kamera yg sudah ada
var pgens=[null,null,null,null]; // referensi ke jenderal tiap 4 owner (indeks by owner), dipakai utk cek kekalahan total & render multi-jenderal
var pgenIdxBase=[22,72,122,172]; // indeks awal jenderal tiap owner di array pc (each owner block = 25 bidak)
// gid -> jumlah member hidup terakhir kali di-reflow, utk deteksi bidak formasi yg mati

var cam={x:1450,y:2350,z:1};

var spd=1.5,pau=false,go=false,lt=0; // kecepatan game TETAP (multiplayer - semua pemain harus jalan di kecepatan sama, tombol 2x dihapus)
var moveMode="atk"; // "atk"=Serang (auto-target musuh sambil jalan), "goto"=jalan mutlak (tapi tetap damage musuh yg menghalangi)
var formMode=null; // null|"globus"|"simplex"|"duplex"|"vshape"
var simplexOri=0; // 0=horizontal,1=vertical (toggle tiap tekan "-")
var duplexOri=0; // 0=horizontal,1=vertical (toggle tiap tekan "=")
var vshapeDir=0; // 0=kanan,1=bawah,2=kiri,3=atas (toggle tiap tekan "v")
var genModes=["kiri","bawah","kanan","atas","tengah"]; // urutan siklus tombol Jendral
var genModeIdx=4; // default "tengah" (spt perilaku lama)
var genMode=genModes[genModeIdx];

var shk=0,shX=0,shY=0;



var cv=document.getElementById("C");

var cx=cv.getContext("2d");

var mc=document.getElementById("MC");

var mx=mc.getContext("2d");

// Cache lapisan latar+poligon minimap (lihat OPTIMASI di render(): hanya digambar ulang saat dirty)
var mCache=document.createElement("canvas");mCache.width=90;mCache.height=56;
var mcCtx=mCache.getContext("2d");
var mcDirty=true;
function drawMinimapBase(sx,sy){
 mcCtx.fillStyle="#0d0f08";mcCtx.fillRect(0,0,90,56);
 if(bgReady)mcCtx.drawImage(bgImg,0,0,90,56);
 for(var t=0;t<tr.length;t++){
  var te=tr[t];mcCtx.beginPath();
  for(var vi=0;vi<te.poly.length;vi++){var vp=te.poly[vi];if(vi===0)mcCtx.moveTo(vp[0]*sx,vp[1]*sy);else mcCtx.lineTo(vp[0]*sx,vp[1]*sy);}
  mcCtx.closePath();
  if(te.tm==="p"){mcCtx.fillStyle="rgba(74,154,74,.45)";mcCtx.fill();}
  mcCtx.strokeStyle=te.tm==="p"?"#4a9a4a":te.bc;mcCtx.lineWidth=0.7;mcCtx.stroke();
 }
 mcDirty=false;
}



function rz(){cv.width=innerWidth;cv.height=innerHeight}

addEventListener("resize",rz);rz();



// WILAYAH (bentuk poligon diambil dari batas garis pada peta acuan asli)

function iTr(){

tr=[
  {nm:"Hutan Sancang",rl:"Maung Sancang",poly:[[3466.9,1801.7],[3317.8,1665.0],[3305.3,1602.9],[3280.5,1752.0],[3230.8,1764.4],[3193.5,1652.6],[3156.2,1627.8],[3168.6,1565.6],[3118.9,1453.8],[3056.8,1503.5],[2982.2,1478.7],[2932.5,1540.8],[2783.4,1503.5],[2646.7,1540.8],[2646.7,1565.6],[2684.0,1578.1],[2646.7,1665.0],[2472.8,1652.6],[2423.1,1689.9],[2348.5,1689.9],[2336.1,1578.1],[2286.4,1553.2],[2236.7,1590.5],[2187.0,1590.5],[2174.6,1640.2],[2087.6,1652.6],[2013.0,1702.3],[1901.2,1702.3],[1851.5,1665.0],[1776.9,1689.9],[1876.3,1764.4],[1851.5,1814.1],[1689.9,1776.9],[1677.5,1863.8],[1516.0,1863.8],[1478.7,1901.1],[1379.3,1901.1],[1342.0,1950.8],[1304.7,1950.8],[1304.7,2000.5],[1242.6,2050.2],[1230.2,2149.6],[1255.0,2249.0],[1205.3,2286.3],[1168.0,2385.7],[1205.3,2522.4],[1180.5,2696.4],[1242.6,2696.4],[1255.0,2659.1],[1329.6,2609.4],[1379.3,2609.4],[1516.0,2683.9],[1926.0,2510.0],[2037.9,2522.4],[2137.3,2485.1],[2274.0,2485.1],[2286.4,2522.4],[2037.9,2646.7],[1938.5,2770.9],[2062.7,2708.8],[2075.1,2783.3],[2137.3,2683.9],[2199.4,2696.4],[2249.1,2671.5],[2261.5,2708.8],[2423.1,2646.7],[2435.5,2708.8],[2385.8,2733.6],[2385.8,2783.3],[2423.1,2770.9],[2460.4,2808.2],[2447.9,2845.5],[2522.5,2808.2],[2534.9,2845.5],[2510.1,2870.3],[2534.9,2907.6],[2584.6,2870.3],[2708.9,2845.5],[2808.3,2758.5],[3007.1,2696.4],[3143.8,2584.5],[3367.5,2559.7],[3491.7,2423.0],[3491.7,2373.3],[3442.0,2323.6],[3442.0,2224.2],[3529.0,2137.2],[3541.4,2075.1],[3466.9,1950.8]],cx:2418.8,cy:2173.8,r:839.2,tm:"n",en:40,cl:"rgba(84,99,38,0.30)",bc:"#3a441a"},
  {nm:"Sunda Kalapa",rl:"Syahbandar Sangadi",poly:[[5430.2,1081.0],[5256.2,1130.7],[5218.9,1230.1],[5094.7,1391.7],[5020.1,1441.4],[4871.0,1491.1],[4833.7,1615.3],[4784.0,1689.9],[4821.3,1789.3],[4821.3,1839.0],[4784.0,1876.3],[4784.0,1938.4],[4970.4,2236.6],[4970.4,2410.6],[4908.3,2522.4],[4933.1,2671.5],[4858.6,2746.1],[4821.3,2820.6],[4796.4,3007.0],[4858.6,3143.7],[4958.0,3255.5],[5169.2,3317.6],[5256.2,3305.2],[5343.2,3243.1],[5504.7,3243.1],[5542.0,3218.2],[5666.3,3044.3],[5852.7,2882.8],[5927.2,2882.8],[6051.5,2808.2],[6101.2,2746.1],[6225.4,2721.2],[6287.6,2659.1],[6387.0,2485.1],[6337.3,2485.1],[6275.1,2435.4],[6237.9,2360.9],[6250.3,2273.9],[6126.0,2137.2],[6076.3,2037.8],[6014.2,1975.7],[6001.8,2013.0],[5964.5,2000.5],[5939.6,1938.4],[5964.5,1776.9],[5815.4,1677.5],[5840.2,1640.2],[5827.8,1590.5],[5753.3,1565.6],[5728.4,1528.4],[5740.8,1428.9],[5703.6,1404.1],[5616.6,1416.5],[5529.6,1354.4],[5554.4,1242.6],[5479.9,1230.1],[5467.5,1354.4],[5417.8,1391.7],[5380.5,1466.2],[5243.8,1503.5],[5169.2,1565.6],[5119.5,1553.2],[5119.5,1528.4],[5206.5,1441.4],[5330.8,1391.7],[5318.3,1354.4],[5368.0,1317.1],[5368.0,1205.3],[5405.3,1180.4],[5380.5,1168.0],[5380.5,1118.3],[5417.8,1105.9],[5430.2,1130.7]],cx:5447.4,cy:2298.5,r:826.6,tm:"n",en:40,cl:"rgba(93,104,36,0.30)",bc:"#404719"},
  {nm:"Muara Sukanagara",rl:"Dipati Sukanagara",poly:[[5144.4,1018.9],[5119.5,1018.9],[5032.5,1105.9],[5007.7,1105.9],[4995.3,1081.0],[4908.3,1105.9],[4895.9,1155.6],[4684.6,1180.4],[4647.3,1217.7],[4523.1,1205.3],[4485.8,1118.3],[4411.2,1068.6],[4374.0,1105.9],[4311.8,1105.9],[4287.0,1081.0],[4287.0,1105.9],[4349.1,1105.9],[4386.4,1130.7],[4398.8,1168.0],[4324.3,1168.0],[4299.4,1217.7],[4212.4,1205.3],[4274.6,1441.4],[4237.3,1478.7],[4187.6,1453.8],[4162.7,1466.2],[4187.6,1602.9],[4125.4,1665.0],[4063.3,1665.0],[4038.5,1640.2],[3988.8,1652.6],[3926.6,1578.1],[3777.5,1565.6],[3765.1,1528.4],[3789.9,1503.5],[3665.7,1515.9],[3553.8,1478.7],[3529.0,1528.4],[3553.8,1578.1],[3553.8,1627.8],[3529.0,1652.6],[3553.8,1839.0],[3541.4,1938.4],[3616.0,2050.2],[3616.0,2137.2],[3541.4,2224.2],[3628.4,2249.0],[3727.8,2336.0],[3901.8,2373.3],[3976.3,2472.7],[4075.7,2485.1],[4175.1,2609.4],[4324.3,2721.2],[4535.5,2659.1],[4647.3,2659.1],[4796.4,2708.8],[4871.0,2634.2],[4833.7,2572.1],[4833.7,2497.6],[4895.9,2410.6],[4908.3,2336.0],[4895.9,2249.0],[4709.5,1950.8],[4709.5,1863.8],[4734.3,1814.1],[4709.5,1727.2],[4709.5,1640.2],[4734.3,1602.9],[4721.9,1565.6],[4759.2,1466.2],[4871.0,1379.2],[4995.3,1354.4],[5032.5,1317.1],[5032.5,1255.0],[5069.8,1230.1],[5144.4,1093.5]],cx:4308.2,cy:1931.8,r:696.1,tm:"n",en:40,cl:"rgba(86,98,36,0.30)",bc:"#3b4319"},
  {nm:"Karangpapak",rl:"Ratu Inten Dewata",poly:[[3019.5,3988.6],[2945.0,3938.9],[2882.8,3926.5],[2758.6,3802.2],[2733.7,3802.2],[2634.3,3678.0],[2609.5,3603.4],[2510.1,3665.6],[2435.5,3665.6],[2286.4,3541.3],[2224.3,3678.0],[2124.9,3740.1],[2062.7,3702.8],[2050.3,3640.7],[1963.3,3615.9],[1938.5,3640.7],[1615.4,3665.6],[1590.5,3690.4],[1453.8,3702.8],[1416.6,3727.7],[1354.4,3715.3],[1329.6,3752.5],[1292.3,3752.5],[1255.0,3715.3],[1217.8,3727.7],[1230.2,3789.8],[1180.5,3814.7],[1354.4,3814.7],[1379.3,3876.8],[1453.8,3901.7],[1466.3,3926.5],[1540.8,3852.0],[1578.1,3852.0],[1590.5,3901.7],[1689.9,3951.4],[1776.9,4075.6],[1839.1,4125.3],[1926.0,4311.7],[1963.3,4485.7],[1950.9,4622.3],[1926.0,4647.2],[1888.8,4634.8],[1876.3,4696.9],[2050.3,4684.5],[2100.0,4709.3],[2236.7,4709.3],[2311.2,4659.6],[2311.2,4609.9],[2261.5,4572.6],[2261.5,4485.7],[2336.1,4398.7],[2323.7,4324.1],[2373.4,4311.7],[2410.7,4349.0],[2435.5,4336.6],[2460.4,4199.9],[2522.5,4150.2],[2534.9,4025.9],[2584.6,4001.1],[2634.3,4013.5],[2646.7,4175.0],[2609.5,4262.0],[2559.8,4299.3],[2534.9,4349.0],[2634.3,4361.4],[2671.6,4498.1],[2733.7,4510.5],[2721.3,4460.8],[2746.2,4423.5],[2746.2,4373.8],[2771.0,4361.4],[2771.0,4286.8],[2882.8,4125.3],[2882.8,4075.6],[2994.7,4038.3]],cx:2198.8,cy:4042.4,r:547.2,tm:"n",en:40,cl:"rgba(95,106,36,0.30)",bc:"#414919"},
  {nm:"Wahanten Agung",rl:"Laksamana Braja",poly:[[2870.4,3765.0],[2845.6,3789.8],[2882.8,3802.2],[2932.5,3864.4],[3007.1,3889.2],[3081.7,3951.4],[3069.2,4063.2],[3007.1,4112.9],[2957.4,4112.9],[2932.5,4187.4],[2895.3,4224.7],[2833.1,4336.6],[2858.0,4373.8],[2895.3,4373.8],[2932.5,4398.7],[2957.4,4498.1],[2994.7,4498.1],[3044.4,4535.4],[3032.0,4647.2],[3081.7,4721.7],[3218.3,4796.3],[3255.6,4771.4],[3305.3,4771.4],[3330.2,4746.6],[3330.2,4672.0],[3367.5,4622.3],[3404.7,4622.3],[3429.6,4647.2],[3429.6,4746.6],[3466.9,4709.3],[3529.0,4684.5],[3553.8,4647.2],[3578.7,4647.2],[3616.0,4684.5],[3616.0,4771.4],[3603.6,4783.9],[3566.3,4771.4],[3541.4,4796.3],[3479.3,4808.7],[3491.7,4821.2],[3553.8,4821.2],[3578.7,4846.0],[3640.8,4833.6],[3678.1,4858.4],[3740.2,4858.4],[3777.5,4883.3],[3802.4,4858.4],[3789.9,4846.0],[3789.9,4721.7],[3802.4,4696.9],[3876.9,4647.2],[3914.2,4585.1],[3926.6,4510.5],[4001.2,4436.0],[4063.3,4423.5],[4113.0,4349.0],[4113.0,4237.1],[4150.3,4075.6],[4038.5,4001.1],[3926.6,4001.1],[3876.9,4025.9],[3752.7,4013.5],[3715.4,3976.2],[3703.0,3926.5],[3678.1,3901.7],[3678.1,3827.1],[3690.5,3814.7],[3678.1,3765.0],[3553.8,3678.0],[3417.2,3715.3],[3317.8,3628.3],[3193.5,3702.8],[3106.5,3727.7],[3044.4,3777.4]],cx:3469.6,cy:4248.4,r:568.1,tm:"n",en:40,cl:"rgba(80,90,31,0.30)",bc:"#373e15"},
  {nm:"Banten Girang",rl:"Prabu Pucuk Umun",poly:[[3876.9,3031.9],[3852.1,3143.7],[3864.5,3218.2],[3901.8,3292.8],[4001.2,3404.6],[4001.2,3466.8],[4088.2,3603.4],[4088.2,3752.5],[4001.2,3876.8],[4001.2,3938.9],[4075.7,3938.9],[4200.0,4025.9],[4287.0,4050.8],[4361.5,4013.5],[4572.8,3976.2],[4610.1,3889.2],[4684.6,3827.1],[4920.7,3814.7],[5107.1,3740.1],[5169.2,3740.1],[5281.1,3789.8],[5305.9,3839.5],[5479.9,3814.7],[5616.6,3827.1],[5678.7,3864.4],[5765.7,3963.8],[6026.6,4100.5],[6138.5,4112.9],[6101.2,3864.4],[6051.5,3752.5],[6026.6,3615.9],[5976.9,3541.3],[5865.1,3516.5],[5778.1,3454.3],[5678.7,3441.9],[5641.4,3404.6],[5641.4,3367.4],[5579.3,3305.2],[5392.9,3305.2],[5281.1,3379.8],[5231.4,3367.4],[5194.1,3392.2],[4933.1,3330.1],[4808.9,3205.8],[4721.9,3031.9],[4721.9,2870.3],[4759.2,2770.9],[4585.2,2721.2],[4311.8,2820.6],[4026.0,2820.6]],cx:4802.1,cy:3471.3,r:710.6,tm:"n",en:40,cl:"rgba(93,100,38,0.30)",bc:"#3f441a"},
  {nm:"Balairung Sri Bima",rl:"Bunisora",poly:[[5566.9,4212.3],[5529.6,4411.1],[5442.6,4572.6],[5442.6,4609.9],[5492.3,4684.5],[5591.7,4734.2],[5641.4,4858.4],[5678.7,5106.9],[5703.6,5156.6],[5703.6,5392.7],[5641.4,5405.2],[5653.8,5467.3],[5691.1,5492.1],[5740.8,5417.6],[5790.5,5417.6],[5827.8,5467.3],[5827.8,5517.0],[5778.1,5541.8],[5778.1,5566.7],[5728.4,5604.0],[5691.1,5715.8],[5616.6,5777.9],[5392.9,5777.9],[5318.3,5728.2],[5392.9,5790.4],[5368.0,5852.5],[5417.8,5852.5],[5430.2,5889.8],[5467.5,5864.9],[5554.4,5877.3],[5604.1,5815.2],[5641.4,5815.2],[5691.1,5852.5],[5703.6,5777.9],[5765.7,5753.1],[5815.4,5765.5],[5877.5,5715.8],[5939.6,5715.8],[5964.5,5740.6],[5952.1,5802.8],[6063.9,5753.1],[6088.8,5777.9],[6175.7,5790.4],[6213.0,5827.6],[6300.0,5840.1],[6374.6,5765.5],[6511.2,5703.4],[6560.9,5641.2],[6660.4,5591.5],[6809.5,5579.1],[6921.3,5504.6],[7132.5,5504.6],[7169.8,5529.4],[7269.2,5492.1],[7281.7,5454.9],[7207.1,5392.7],[7194.7,5256.0],[7145.0,5156.6],[7033.1,5044.8],[7020.7,4995.1],[6958.6,4957.8],[6834.3,4933.0],[6734.9,4858.4],[6697.6,4634.8],[6635.5,4597.5],[6598.2,4448.4],[6536.1,4373.8],[6362.1,4324.1],[6150.9,4175.0],[6026.6,4175.0],[5877.5,4100.5],[5753.3,4162.6],[5616.6,4175.0]],cx:6233.2,cy:5017.0,r:783.0,tm:"n",en:40,cl:"rgba(88,97,36,0.30)",bc:"#3d4219"},
  {nm:"Keraton Surawisesa",rl:"Rakeyan Surawisesa",poly:[[7629.6,2124.8],[7567.5,2137.2],[7480.5,2236.6],[7430.8,2236.6],[7418.3,2336.0],[7207.1,2522.4],[7219.5,2646.7],[7082.8,2808.2],[6933.7,2808.2],[6710.1,2646.7],[6635.5,2547.3],[6635.5,2472.7],[6697.6,2410.6],[6660.4,2398.2],[6660.4,2360.9],[6511.2,2534.8],[6424.3,2584.5],[6275.1,2795.8],[6150.9,2820.6],[6001.8,2944.9],[5840.2,2982.2],[5629.0,3243.1],[5716.0,3379.8],[5827.8,3392.2],[6039.1,3491.6],[6163.3,3827.1],[6225.4,4125.3],[6424.3,4274.4],[6560.9,4299.3],[6672.8,4423.5],[6685.2,4535.4],[6772.2,4609.9],[6797.0,4821.2],[6995.9,4895.7],[7095.3,4970.3],[7232.0,5144.2],[7281.7,5367.9],[7331.4,5392.7],[7505.3,5343.0],[7679.3,5367.9],[7778.7,5256.0],[7853.3,5268.5],[7927.8,5231.2],[7952.7,4858.4],[8076.9,4622.3],[8076.9,4398.7],[8263.3,4100.5],[8275.7,4001.1],[8126.6,4001.1],[8089.3,3963.8],[8089.3,3876.8],[8139.1,3814.7],[8250.9,3777.4],[8313.0,3653.1],[8412.4,3615.9],[8412.4,3578.6],[8300.6,3491.6],[8139.1,3466.8],[8076.9,3392.2],[8076.9,3243.1],[7840.8,3094.0],[7766.3,3007.0],[7716.6,2882.8],[7741.4,2634.2],[7642.0,2559.7],[7654.4,2522.4],[7741.4,2534.8],[7642.0,2423.0],[7666.9,2385.7],[7567.5,2373.3],[7530.2,2311.2],[7579.9,2249.0],[7642.0,2298.7],[7629.6,2224.2],[7567.5,2211.8],[7567.5,2149.6]],cx:7156.2,cy:3768.1,r:1210.6,tm:"n",en:40,cl:"rgba(97,101,34,0.30)",bc:"#434517"},
  {nm:"Puri Pakañcilan",rl:"Ratu Kentring Manik",poly:[[8238.5,6585.6],[8238.5,6560.7],[8089.3,6436.5],[8014.8,6275.0],[7903.0,6150.7],[7865.7,6063.7],[7753.8,5951.9],[7679.3,5902.2],[7555.0,5877.3],[7393.5,5877.3],[7331.4,5852.5],[7281.7,5802.8],[7256.8,5715.8],[7269.2,5641.2],[7381.1,5529.4],[7405.9,5454.9],[7343.8,5504.6],[7318.9,5554.3],[7182.2,5616.4],[7132.5,5616.4],[7082.8,5566.7],[6983.4,5566.7],[6846.7,5641.2],[6697.6,5653.7],[6548.5,5765.5],[6399.4,5827.6],[6374.6,5852.5],[6399.4,5864.9],[6387.0,5927.0],[6337.3,5951.9],[6188.2,5964.3],[6200.6,6001.6],[6225.4,5976.7],[6275.1,5976.7],[6300.0,6001.6],[6312.4,6125.8],[6225.4,6188.0],[6150.9,6200.4],[6126.0,6237.7],[6101.2,6237.7],[6063.9,6188.0],[6026.6,6250.1],[5976.9,6262.5],[6051.5,6299.8],[6101.2,6374.4],[6101.2,6448.9],[6051.5,6523.5],[6014.2,6523.5],[6026.6,6535.9],[6101.2,6535.9],[6188.2,6610.4],[6188.2,6560.7],[6225.4,6523.5],[6324.9,6511.0],[6461.5,6672.6],[6536.1,6660.1],[6560.9,6610.4],[6635.5,6622.9],[6734.9,6573.2],[6784.6,6511.0],[6809.5,6436.5],[6971.0,6287.4],[7107.7,6250.1],[7194.7,6188.0],[7281.7,6175.5],[7430.8,6188.0],[7555.0,6237.7],[7617.2,6287.4],[7679.3,6287.4],[7741.4,6349.5],[7791.1,6473.8],[7878.1,6535.9],[8089.3,6622.9],[8213.6,6610.4]],cx:6984.2,cy:6126.3,r:612.7,tm:"n",en:40,cl:"rgba(99,103,41,0.30)",bc:"#44471c"},
  {nm:"Mandala Samida",rl:"Ki Juru Samida",poly:[[7294.1,6237.7],[7219.5,6250.1],[7145.0,6312.2],[7107.7,6312.2],[6908.9,6511.0],[6871.6,6573.2],[6871.6,6647.7],[6821.9,6697.4],[6859.2,6921.1],[6784.6,7008.1],[6685.2,6995.6],[6647.9,7020.5],[6846.7,7057.8],[6971.0,7045.3],[7082.8,7107.5],[7095.3,7082.6],[7132.5,7082.6],[7182.2,7144.7],[7219.5,7343.6],[7244.4,7318.7],[7207.1,7256.6],[7207.1,7206.9],[7269.2,7194.5],[7294.1,7219.3],[7318.9,7306.3],[7294.1,7393.3],[7331.4,7430.5],[7331.4,7492.7],[7294.1,7505.1],[7207.1,7430.5],[7194.7,7393.3],[7157.4,7405.7],[7082.8,7567.2],[6946.2,7666.6],[6958.6,7716.3],[6896.4,7766.0],[6834.3,7778.5],[6809.5,7940.0],[6995.9,8089.1],[7182.2,8325.2],[7256.8,8374.9],[7343.8,8586.1],[7530.2,8499.1],[7617.2,8486.7],[7729.0,8325.2],[7853.3,8275.5],[7940.2,8200.9],[7965.1,8151.2],[7952.7,7977.3],[8027.2,7890.3],[8101.8,7728.8],[8114.2,7418.1],[8151.5,7356.0],[8350.3,7169.6],[8375.1,7095.0],[8487.0,6958.4],[8511.8,6834.1],[8449.7,6784.4],[8387.6,6660.1],[8188.8,6697.4],[8039.6,6685.0],[7766.3,6548.3],[7654.4,6349.5],[7617.2,6361.9],[7480.5,6275.0]],cx:7556.2,cy:7324.4,r:866.3,tm:"n",en:40,cl:"rgba(99,102,42,0.30)",bc:"#44461d"},
  {nm:"Mandala Dipuntang",rl:"Resi Dipuntang",poly:[[7368.6,8648.3],[7405.9,8698.0],[7418.3,8871.9],[7331.4,9095.6],[8387.6,9095.6],[8400.0,9070.7],[8449.7,9070.7],[8462.1,9095.6],[8474.6,9070.7],[8586.4,9070.7],[8598.8,9095.6],[9443.8,9095.6],[9481.1,9070.7],[9493.5,9095.6],[9568.0,9095.6],[9630.2,9033.4],[9766.9,9033.4],[9841.4,9095.6],[9928.4,9095.6],[9965.7,8934.0],[9953.3,8598.5],[9853.8,8325.2],[9866.3,8188.5],[9791.7,8076.7],[9630.2,7940.0],[9332.0,7853.0],[9220.1,7778.5],[9182.8,7691.5],[9145.6,7716.3],[9133.1,7666.6],[9158.0,7654.2],[9095.9,7529.9],[9046.2,7567.2],[9008.9,7517.5],[9058.6,7443.0],[8971.6,7368.4],[8921.9,7380.8],[8897.0,7343.6],[8884.6,7368.4],[8847.3,7356.0],[8884.6,7293.9],[8847.3,7281.4],[8785.2,7032.9],[8660.9,6933.5],[8561.5,6921.1],[8549.1,7008.1],[8412.4,7206.9],[8201.2,7418.1],[8163.9,7529.9],[8163.9,7778.5],[8114.2,7902.7],[8027.2,8014.5],[8027.2,8213.4],[7927.8,8325.2],[7791.1,8374.9],[7679.3,8536.4]],cx:8740.1,cy:8341.9,r:1027.7,tm:"n",en:40,cl:"rgba(88,91,33,0.30)",bc:"#3c3f17"},
  {nm:"Kawali Amukti",rl:"Empu Kawaliram",poly:[[8772.8,6747.1],[8723.1,6896.2],[8859.8,7008.1],[8934.3,7231.7],[9108.3,7368.4],[9282.2,7728.8],[9679.9,7877.9],[9916.0,8126.4],[9928.4,8325.2],[10027.8,8586.1],[10015.4,9070.7],[10549.7,9095.6],[10760.9,9033.4],[10798.2,9095.6],[10910.1,9095.6],[11084.0,8859.5],[11282.8,8722.8],[11444.4,8449.4],[11469.2,8561.3],[11419.5,8673.1],[10984.6,9095.6],[12438.5,9095.6],[12426.0,8884.3],[12214.8,8586.1],[12165.1,8350.0],[12078.1,8250.6],[12090.5,8151.2],[11941.4,8027.0],[11941.4,7790.9],[12003.6,7641.8],[12276.9,7269.0],[12351.5,6921.1],[12264.5,6647.7],[12090.5,6560.7],[12028.4,6337.1],[11692.9,6051.3],[11407.1,5989.2],[11320.1,5889.8],[11158.6,5877.3],[11021.9,5976.7],[10748.5,5927.0],[10462.7,6026.4],[10201.8,6212.8],[9853.8,6200.4],[9456.2,6287.4],[9195.3,6498.6],[9008.9,6560.7]],cx:10791.1,cy:7474.9,r:1610.5,tm:"n",en:40,cl:"rgba(89,93,32,0.30)",bc:"#3d4016"},
  {nm:"Pakuan Pajajaran",rl:"Prabu Siliwangi",poly:[[10375.7,3802.2],[10301.2,3765.0],[10189.3,3827.1],[10089.9,3839.5],[9779.3,4162.6],[9630.2,4137.7],[9481.1,4050.8],[9356.8,4063.2],[9257.4,4038.3],[9120.7,4187.4],[9058.6,4187.4],[8859.8,4100.5],[8723.1,4112.9],[8623.7,4038.3],[8524.3,4038.3],[8449.7,4100.5],[8325.4,4088.0],[8226.0,4336.6],[8139.1,4436.0],[8151.5,4622.3],[8014.8,4908.1],[8014.8,5193.9],[7989.9,5256.0],[8114.2,5467.3],[8064.5,5678.5],[8139.1,5802.8],[8139.1,5939.5],[8039.6,6101.0],[8039.6,6175.5],[8163.9,6411.6],[8288.2,6511.0],[8300.6,6598.0],[8437.3,6598.0],[8511.8,6747.1],[8611.2,6846.5],[8648.5,6859.0],[8747.9,6660.1],[8971.6,6498.6],[9170.4,6424.1],[9431.4,6212.8],[9555.6,6175.5],[9742.0,6175.5],[9853.8,6125.8],[10015.4,6163.1],[10189.3,6138.3],[10462.7,5939.5],[10487.6,5864.9],[10425.4,5765.5],[10375.7,5504.6],[10475.1,5243.6],[10500.0,5069.7],[10462.7,4995.1],[10413.0,4659.6],[10263.9,4398.7],[10251.5,4237.1]],cx:9210.7,cy:5240.8,r:1305.6,tm:"n",en:40,cl:"rgba(111,103,32,0.30)",bc:"#4c4616"},
  {nm:"Wanagiri",rl:"Ki Buyut Wanagiri",poly:[[10972.2,2808.2],[10723.7,2634.2],[10487.6,2534.8],[10201.8,2273.9],[10164.5,2298.7],[10127.2,2261.5],[10040.2,2249.0],[10127.2,2336.0],[10102.4,2410.6],[9965.7,2447.9],[9841.4,2522.4],[9953.3,2572.1],[10040.2,2559.7],[10052.7,2609.4],[9754.4,2597.0],[9816.6,2621.8],[9841.4,2683.9],[9754.4,2671.5],[9754.4,2770.9],[9617.8,2795.8],[9617.8,2833.0],[9779.3,2808.2],[10003.0,2920.0],[10040.2,2957.3],[10027.8,2994.6],[9704.7,2994.6],[9605.3,2957.3],[9630.2,2907.6],[9580.5,2920.0],[9605.3,2932.5],[9592.9,2969.7],[9481.1,2932.5],[9493.5,2895.2],[9555.6,2870.3],[9493.5,2870.3],[9431.4,2808.2],[9431.4,2770.9],[9220.1,2857.9],[9269.8,2957.3],[9245.0,2982.2],[9083.4,2957.3],[9058.6,2982.2],[9071.0,3143.7],[8984.0,3267.9],[8834.9,3354.9],[8810.1,3441.9],[8760.4,3491.6],[8524.3,3541.3],[8462.1,3678.0],[8424.9,3715.3],[8350.3,3715.3],[8151.5,3914.1],[8176.3,3938.9],[8300.6,3914.1],[8337.9,3951.4],[8337.9,4013.5],[8400.0,4038.3],[8487.0,3976.2],[8685.8,3976.2],[8760.4,4050.8],[8897.0,4038.3],[9108.3,4112.9],[9158.0,4025.9],[9257.4,3963.8],[9518.3,3976.2],[9642.6,4063.2],[9766.9,4088.0],[9816.6,3988.6],[10065.1,3777.4],[10251.5,3702.8],[10363.3,3702.8],[10437.9,3752.5],[10524.9,3653.1],[10636.7,3591.0],[10711.2,3491.6],[10736.1,3392.2],[10910.1,3243.1]],cx:9759.7,cy:3322.1,r:903.4,tm:"n",en:40,cl:"rgba(107,96,28,0.30)",bc:"#494213"},
  {nm:"Pagerwesi",rl:"Jenderal Wirasentana",poly:[[11929.0,3193.4],[11779.9,3143.7],[11605.9,3255.5],[11556.2,3181.0],[11506.5,3156.1],[11245.6,3342.5],[10934.9,3342.5],[10785.8,3454.3],[10773.4,3528.9],[10686.4,3653.1],[10574.6,3715.3],[10462.7,3827.1],[10338.5,4150.2],[10326.0,4311.7],[10350.9,4423.5],[10475.1,4609.9],[10524.9,4945.4],[10574.6,5082.1],[10549.7,5256.0],[10450.3,5492.1],[10487.6,5728.2],[10549.7,5840.1],[10537.3,5927.0],[10698.8,5864.9],[10860.4,5864.9],[11009.5,5902.2],[11158.6,5802.8],[11320.1,5827.6],[11394.7,5703.4],[11556.2,5628.8],[11556.2,5566.7],[11593.5,5566.7],[11605.9,5604.0],[11605.9,5566.7],[11531.4,5541.8],[11556.2,5454.9],[11593.5,5454.9],[11605.9,5492.1],[11618.3,5454.9],[11668.0,5454.9],[11705.3,5529.4],[11779.9,5492.1],[11978.7,5479.7],[12016.0,5442.4],[12028.4,5318.2],[12115.4,5156.6],[12078.1,5131.8],[12078.1,5094.5],[12165.1,5069.7],[12214.8,4870.9],[12314.2,4709.3],[12314.2,4634.8],[12264.5,4659.6],[12252.1,4622.3],[12202.4,4622.3],[12214.8,4560.2],[12252.1,4547.8],[12314.2,4585.1],[12351.5,4423.5],[12426.0,4286.8],[12376.3,3852.0],[12252.1,3740.1],[12202.4,3628.3],[12028.4,3404.6],[12016.0,3330.1]],cx:11340.1,cy:4494.9,r:1151.0,tm:"n",en:40,cl:"rgba(101,97,27,0.30)",bc:"#454212"},
  {nm:"Saunggalah",rl:"Prabu Jayaprakosa",poly:[[14960.9,2249.0],[14799.4,2124.8],[14476.3,1975.7],[14178.1,1926.0],[13855.0,2075.1],[13705.9,2348.4],[13494.7,2534.8],[13171.6,2659.1],[12910.7,2646.7],[12836.1,2708.8],[12711.8,2708.8],[12488.2,2870.3],[12165.1,2870.3],[12003.6,2957.3],[11953.8,3056.7],[11978.7,3143.7],[12301.8,3678.0],[12438.5,3814.7],[12475.7,4212.3],[12624.9,4075.6],[12724.3,4050.8],[12910.7,3864.4],[12873.4,3852.0],[12873.4,3802.2],[12947.9,3715.3],[13022.5,3777.4],[13097.0,3752.5],[13109.5,3702.8],[13233.7,3752.5],[13370.4,3715.3],[13271.0,3702.8],[13283.4,3640.7],[13457.4,3640.7],[13519.5,3678.0],[13556.8,3628.3],[13556.8,3479.2],[13668.6,3267.9],[14066.3,2944.9],[14153.3,2944.9],[14414.2,2733.6],[14376.9,2696.4],[14401.8,2659.1],[14327.2,2646.7],[14314.8,2609.4],[14501.2,2447.9],[14401.8,2398.2],[14488.8,2286.3],[14426.6,2224.2],[14339.6,2286.3],[14376.9,2298.7],[14352.1,2348.4],[14215.4,2398.2],[14289.9,2410.6],[14302.4,2447.9],[14203.0,2472.7],[14227.8,2547.3],[14178.1,2597.0],[13954.4,2609.4],[13954.4,2547.3],[13842.6,2534.8],[13855.0,2497.6],[13966.9,2460.3],[14029.0,2497.6],[14128.4,2472.7],[14116.0,2385.7],[14327.2,2224.2],[14190.5,2162.1],[14053.8,2162.1],[14053.8,2099.9],[14439.1,2112.4],[14463.9,2162.1],[14874.0,2336.0],[14936.1,2460.3],[14737.3,2447.9],[14836.7,2534.8],[14787.0,2634.2],[14712.4,2683.9],[14998.2,2497.6],[15023.1,2398.2]],cx:13270.7,cy:3020.7,r:862.7,tm:"n",en:40,cl:"rgba(111,91,24,0.30)",bc:"#4c3f10"},
  {nm:"Pasir Batang",rl:"Raden Kamandaka",poly:[[15060.4,3789.8],[14923.7,3814.7],[14886.4,3727.7],[14886.4,3802.2],[14824.3,3765.0],[14762.1,3827.1],[14700.0,3814.7],[14588.2,3876.8],[14600.6,3789.8],[14563.3,3715.3],[14637.9,3640.7],[14613.0,3566.2],[14575.7,3603.4],[14526.0,3591.0],[14575.7,3516.5],[14550.9,3504.0],[14575.7,3379.8],[14376.9,3466.8],[14277.5,3441.9],[14240.2,3491.6],[14091.1,3454.3],[14103.6,3417.1],[14240.2,3417.1],[14501.2,3292.8],[14414.2,3280.4],[14240.2,3354.9],[14041.4,3342.5],[14078.7,3292.8],[14277.5,3267.9],[14277.5,3181.0],[14389.3,3094.0],[14227.8,3168.5],[14203.0,3056.7],[14451.5,3031.9],[14401.8,3007.0],[14401.8,2870.3],[14352.1,2870.3],[14128.4,3106.4],[14091.1,3056.7],[13743.2,3305.2],[13917.2,3280.4],[13942.0,3367.4],[13805.3,3392.2],[13792.9,3417.1],[13867.5,3404.6],[13879.9,3454.3],[13730.8,3466.8],[13755.6,3528.9],[13705.9,3578.6],[13668.6,3566.2],[13693.5,3504.0],[13643.8,3491.6],[13618.9,3702.8],[13544.4,3765.0],[13482.2,3765.0],[13469.8,3852.0],[13159.2,3889.2],[13271.0,3876.8],[13295.9,3926.5],[13246.2,3938.9],[13358.0,4001.1],[13258.6,4112.9],[12910.7,4137.7],[12910.7,4088.0],[13109.5,4063.2],[13084.6,4025.9],[13109.5,3926.5],[13059.8,3914.1],[12985.2,4025.9],[12873.4,4075.6],[12860.9,4025.9],[12972.8,3963.8],[12935.5,3938.9],[12711.8,4150.2],[12624.9,4162.6],[12575.1,4274.4],[12749.1,4349.0],[12935.5,4311.7],[13059.8,4398.7],[13258.6,4336.6],[13407.7,4498.1],[13507.1,4783.9],[13755.6,4796.3],[13991.7,4709.3],[14103.6,4597.5],[14426.6,4398.7],[14637.9,4175.0],[14774.6,4125.3]],cx:13916.7,cy:4029.3,r:726.1,tm:"n",en:40,cl:"rgba(106,87,22,0.30)",bc:"#493b0f"},
  {nm:"Huma Beunghar",rl:"Tuan Tanah Beunghar",poly:[[14712.4,4237.1],[14066.3,4746.6],[13780.5,4858.4],[13569.2,4846.0],[13271.0,5144.2],[13407.7,5218.8],[13445.0,5069.7],[13544.4,5106.9],[13482.2,5280.9],[13792.9,5343.0],[13792.9,5405.2],[13445.0,5355.5],[13382.8,5268.5],[13109.5,5467.3],[13047.3,5380.3],[12923.1,5442.4],[13109.5,5467.3],[13084.6,5541.8],[12848.5,5529.4],[12898.2,5405.2],[12488.2,5529.4],[12140.2,5479.7],[11469.2,5740.6],[11419.5,5889.8],[11829.6,6038.9],[11966.3,6001.6],[12127.8,6200.4],[12202.4,6188.0],[12016.0,5976.7],[12301.8,6001.6],[12214.8,6125.8],[12351.5,6250.1],[12388.8,6188.0],[12525.4,6411.6],[12202.4,6361.9],[11866.9,6101.0],[12115.4,6312.2],[12140.2,6511.0],[12339.1,6622.9],[12637.3,6610.4],[13159.2,6324.7],[13556.8,6374.4],[14066.3,6212.8],[14314.8,6051.3],[13929.6,6237.7],[13656.2,6237.7],[13656.2,6138.3],[13879.9,5976.7],[13768.0,6175.5],[14203.0,6001.6],[13954.4,5927.0],[13743.2,5976.7],[13755.6,5902.2],[13395.3,6250.1],[12562.7,6473.8],[12649.7,6324.7],[12736.7,6361.9],[12823.7,6287.4],[12525.4,6051.3],[12798.8,6138.3],[12935.5,6287.4],[13097.0,6188.0],[12923.1,6038.9],[12836.1,6038.9],[12898.2,6175.5],[12662.1,6063.7],[12699.4,5927.0],[13469.8,5504.6],[13792.9,5591.5],[13420.1,5591.5],[13171.6,5715.8],[13308.3,5852.5],[13643.8,5690.9],[13606.5,5790.4],[13668.6,5827.6],[13879.9,5566.7],[14265.1,5678.5],[14364.5,5790.4],[14302.4,5902.2],[14414.2,5927.0],[14339.6,6026.4],[14550.9,5927.0],[14675.1,5765.5],[14414.2,5728.2],[13830.2,5417.6],[14103.6,5057.2],[14600.6,4833.6],[14749.7,4535.4]],cx:13264.2,cy:5625.7,r:788.8,tm:"n",en:40,cl:"rgba(101,90,26,0.30)",bc:"#453e12"},
  {nm:"Kadipaten Galuh",rl:"Prabu Niskala",poly:[[15669.2,7393.3],[14973.4,7219.3],[14874.0,7008.1],[14426.6,7032.9],[14203.0,6921.1],[13867.5,6598.0],[13892.3,6349.5],[13519.5,6461.3],[13171.6,6399.2],[12649.7,6685.0],[12339.1,6685.0],[12426.0,6945.9],[12823.7,7356.0],[12562.7,7269.0],[12513.0,7082.6],[12388.8,7020.5],[12326.6,7343.6],[12003.6,7902.7],[12463.3,8772.5],[12525.4,9095.6],[13121.9,9070.7],[13233.7,8983.7],[13059.8,9033.4],[13171.6,8871.9],[13047.3,8958.9],[12997.6,8921.6],[13097.0,8847.1],[12885.8,8971.3],[12798.8,8934.0],[13196.4,8722.8],[13320.7,8784.9],[13469.8,8660.7],[13109.5,8151.2],[13097.0,7679.1],[12860.9,7356.0],[13134.3,7554.8],[13184.0,8126.4],[13532.0,8623.4],[13693.5,8499.1],[13892.3,8611.0],[14128.4,8374.9],[14314.8,8461.9],[14488.8,8399.7],[13979.3,8263.1],[14103.6,8200.9],[14190.5,8287.9],[14613.0,8076.7],[14836.7,8138.8],[14762.1,8064.2],[14936.1,7989.7],[14886.4,7940.0],[14662.7,8039.4],[14662.7,7940.0],[14389.3,7940.0],[14463.9,7952.4],[14401.8,8051.8],[14538.5,8089.1],[14364.5,8064.2],[14252.7,8113.9],[14364.5,8176.1],[14215.4,8225.8],[13830.2,8138.8],[13743.2,8014.5],[14153.3,8027.0],[13730.8,7989.7],[13532.0,7778.5],[13469.8,7803.3],[13457.4,7654.2],[13681.1,7616.9],[13569.2,7467.8],[13705.9,7443.0],[13457.4,7455.4],[13569.2,7492.7],[13594.1,7616.9],[13295.9,7517.5],[13358.0,7443.0],[13134.3,7318.7],[13246.2,7157.2],[13494.7,7256.6],[13420.1,7182.0],[13494.7,7045.3],[13606.5,7256.6],[13718.3,7269.0],[13718.3,7169.6],[13830.2,7119.9],[13842.6,7281.4],[14041.4,7331.1],[13966.9,7393.3],[14190.5,7405.7],[14277.5,7505.1],[14140.8,7517.5],[14488.8,7604.5],[14277.5,7679.1],[14836.7,7654.2],[14836.7,7877.9],[15035.5,7716.3],[15333.7,7778.5],[15383.4,7666.6],[15569.8,7654.2],[15607.1,7542.4],[15358.6,7641.8],[15308.9,7592.1]],cx:13366.7,cy:7679.9,r:1139.2,tm:"n",en:40,cl:"rgba(93,87,29,0.30)",bc:"#403c14"},
  {nm:"Giri Kancana",rl:"Ratu Dewata",poly:[[11419.5,1689.9],[11432.0,1727.2],[11543.8,1826.6],[11730.2,1888.7],[11767.5,1926.0],[11817.2,2062.7],[11978.7,2112.4],[12053.3,2050.2],[12152.7,2050.2],[12189.9,2075.1],[12177.5,2112.4],[12103.0,2099.9],[12016.0,2137.2],[12065.7,2186.9],[12090.5,2273.9],[12090.5,2447.9],[12202.4,2584.5],[12202.4,2795.8],[12450.9,2808.2],[12662.1,2646.7],[12823.7,2634.2],[12873.4,2584.5],[12923.1,2572.1],[13233.7,2572.1],[13358.0,2485.1],[13532.0,2435.4],[13656.2,2286.3],[13718.3,2149.6],[13718.3,1950.8],[13656.2,1863.8],[13544.4,1764.4],[13420.1,1702.3],[13134.3,1689.9],[13010.1,1652.6],[12947.9,1615.3],[12823.7,1478.7],[12724.3,1491.1],[12662.1,1453.8],[12649.7,1416.5],[12587.6,1366.8],[12575.1,1391.7],[12426.0,1391.7],[12264.5,1354.4],[12276.9,1404.1],[12351.5,1466.2],[12326.6,1540.8],[12028.4,1478.7],[11978.7,1404.1],[11916.6,1503.5],[11879.3,1478.7],[11792.3,1478.7],[11755.0,1528.4],[11705.3,1553.2],[11668.0,1540.8],[11668.0,1590.5],[11692.9,1590.5],[11779.9,1677.5],[11779.9,1727.2],[11717.8,1739.6],[11705.3,1764.4],[11506.5,1702.3],[11481.7,1677.5],[11456.8,1702.3]],cx:12665.1,cy:2040.0,r:758.7,tm:"n",en:40,cl:"rgba(113,91,30,0.30)",bc:"#4d3e14"}
 ];

 // alias x/y=cx/cy supaya fungsi lama (ds, dsb) yg pakai .x/.y tetap jalan tanpa diubah semua
 for(var ti=0;ti<tr.length;ti++){tr[ti].x=tr[ti].cx;tr[ti].y=tr[ti].cy;}

}



// PENGHALANG TEPI MAP (batu coklat kehitaman)

function iRocks(){

 rocks=[];

 function addBand(n,xf,yf){

  for(var k=0;k<n;k++){

   rocks.push({x:xf(),y:yf(),r:7+Math.random()*16,sh:Math.random()});

  }

 }

 addBand(Math.round(BW/38),function(){return Math.random()*BW},function(){return -Math.random()*BORDER*0.95});

 addBand(Math.round(BW/38),function(){return Math.random()*BW},function(){return BH+Math.random()*BORDER*0.95});

 addBand(Math.round(BH/38),function(){return -Math.random()*BORDER*0.95},function(){return Math.random()*BH});

 addBand(Math.round(BH/38),function(){return BW+Math.random()*BORDER*0.95},function(){return Math.random()*BH});

}




// TERRAIN: latar dunia sekarang memakai gambar peta asli (bgImg) yg digambar langsung di render(),
// jadi garis pantai & pegunungan prosedural sudah tak diperlukan lagi.

// UTIL: point-in-polygon (dipakai utk deteksi bidak di dalam wilayah & sebar pasukan musuh)
function pip(poly,x,y){
 var n=poly.length,inside=false;
 for(var i=0,j=n-1;i<n;j=i++){
  var xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
  if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))inside=!inside;
 }
 return inside;
}
function polyBounds(poly){
 var minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
 for(var i=0;i<poly.length;i++){var p=poly[i];if(p[0]<minX)minX=p[0];if(p[0]>maxX)maxX=p[0];if(p[1]<minY)minY=p[1];if(p[1]>maxY)maxY=p[1];}
 return{minX:minX,minY:minY,maxX:maxX,maxY:maxY};
}
function randPtInPoly(te){
 if(!te.bb)te.bb=polyBounds(te.poly);
 for(var tries=0;tries<24;tries++){
  var x=te.bb.minX+Math.random()*(te.bb.maxX-te.bb.minX);
  var y=te.bb.minY+Math.random()*(te.bb.maxY-te.bb.minY);
  if(pip(te.poly,x,y))return{x:x,y:y};
 }
 return{x:te.cx,y:te.cy};
}
// Sama seperti randPtInPoly, tapi titik dipaksa berada di sisi x>=minX (dipakai supaya spawn musuh di
// wilayah yg berbatasan dgn markas pemain tidak muncul terlalu dekat - musuh digeser ke sisi kanan wilayah).
function randPtInPolyMinX(te,minX){
 if(!te.bb)te.bb=polyBounds(te.poly);
 var loX=Math.max(te.bb.minX,minX);
 for(var tries=0;tries<24;tries++){
  var x=loX+Math.random()*(te.bb.maxX-loX);
  var y=te.bb.minY+Math.random()*(te.bb.maxY-te.bb.minY);
  if(pip(te.poly,x,y))return{x:x,y:y};
 }
 return randPtInPoly(te);
}

// BIDAK

function mkP(x,y,t,i){return{x:x,y:y,t:t,i:i,a:t==="p"?0:Math.PI,ox:x,oy:y,ord:null,gtx:null,gty:null,tgt:null,zone:null,orbiting:null,orbitDir:(Math.random()>0.5?1:-1),gid:0,al:true,hp:100,mhp:100,gen:false,rt:false,rt2:0,hf:0,eng:null,moc:0,obey:false,form:null,formAng:0,gotoBlock:false,slotIdx:0,hidden:false,owner:0}}



var OWNER_HOME=[null,null,null,null]; // {x,y} markas tiap owner, dipakai ulang saat respawn

function spawnOwnerGroup(ownerIdx,homeX,homeY){
 // 25 bidak (termasuk 1 jendral) dlm barisan 6x4 (24 bidak biasa) + 1 baris tambahan berisi
 // 1 bidak (jendral) di tengah bawah, ditata di sekitar homeX/homeY milik owner ini
 var startIdx=pc.length;
 for(var i=0;i<24;i++){
  var rw=i%6,cl=Math.floor(i/6);
  var p=mkP(homeX-100+rw*40+(Math.random()-.5)*10,homeY-80+cl*40+(Math.random()-.5)*10,"p",-1);
  p.owner=ownerIdx;
  pc.push(p);
 }
 // bidak ke-25 (jendral): baris ke-5, di tengah horizontal blok 6 kolom
 var genP=mkP(homeX-100+2.5*40+(Math.random()-.5)*10,homeY-80+4*40+(Math.random()-.5)*10,"p",-1);
 genP.owner=ownerIdx;
 pc.push(genP);
 var gp=pc[startIdx+24]; // bidak ke-25 (indeks 24 dari 25) jadi jendral
 gp.gen=true;gp.hp=gp.mhp=400;gp.warn=false;
 pgens[ownerIdx]=gp;
 pgenIdxBase[ownerIdx]=startIdx+24;
 OWNER_HOME[ownerIdx]={x:homeX,y:homeY};
 return startIdx;
}

function iPc(){

 pc=[];

 // 4 markas pemain berdampingan di sisi KIRI wilayah Sancang (dekat tepi laut), tetap terpisah
 // dari area spawn musuh yg dibatasi ke sisi KANAN Sancang (lihat SANCANG_SPLIT_X di bawah).
 // Titik Y (2110/2243/2377/2510) diverifikasi manual berada DI DALAM poligon Hutan Sancang utk
 // seluruh area blok 6x4+1 bidak (bukan cuma titik tengahnya) - blok ini lebih lebar dari versi
 // 5x5 sebelumnya jadi titik lama sebagian jatuh di luar poligon, sudah dihitung ulang.
 // PENTING: cuma spawn owner yg SLOT-NYA TERISI (mpPlayers[oi] != null) - kalau cuma 2-3 pemain
 // yg join & mulai, owner kosong TIDAK di-spawn sama sekali (bukan spawn lalu langsung dianggap
 // "kalah"), supaya game bisa dimainkan berapa pun jumlah pemain (2, 3, atau 4).
 var HOME_Y=[2110,2243,2377,2510];
 for(var oi=0;oi<4;oi++){
  if(mpPlayers[oi]) spawnOwnerGroup(oi,1400,HOME_Y[oi]);
 }

 pgenIdx=pgenIdxBase[mpMyOwner];
 pgen=pc[pgenIdx];

 // Garis pemisah horizontal di dalam wilayah Sancang: markas pemain di sisi kiri (x<garis ini),
 // spawn musuh di Sancang dipaksa muncul di sisi kanan (x>=garis ini) supaya ada jarak aman di antara keduanya.
 var SANCANG_SPLIT_X=2300;

 for(var t=0;t<tr.length;t++){

  var te=tr[t];

  var gpos=null;
  for(var j=0;j<te.en;j++){
   var sp=(te.nm==="Hutan Sancang")?randPtInPolyMinX(te,SANCANG_SPLIT_X):randPtInPoly(te);
   if(j===0)gpos=sp;
   else if(j<=12){ // 12 pengawal berkumpul di sekitar jenderal
    for(var k2=0;k2<12;k2++){var an=Math.random()*6.283,rd=45+Math.random()*70,qx=gpos.x+Math.cos(an)*rd,qy=gpos.y+Math.sin(an)*rd;if(pip(te.poly,qx,qy)){sp={x:qx,y:qy};break}}
   }
   var p=mkP(sp.x,sp.y,"e",t);
   if(j===0){p.gen=true;p.hp=p.mhp=300;te.gp=p;te.st="idle";te.form=["globus","simplex","duplex","vshape"][Math.floor(Math.random()*4)]}
   p.role=(j>12&&j%3===0)?"inf":"atk"; // inf=informan (tak bertarung, jadi pelari pemberi kabar)

   // FOG OF WAR PER-WILAYAH: musuh disembunyikan (tidak disimulasikan/tidak digambar) sampai
   // ada bidak pemain yg benar2 masuk ke wilayah ini (lihat blok "Wilayah" di update() utk toggle-nya).
   // Ini sekaligus optimasi (bidak yg hidden tak ikut diproses tiap frame) & strategi baru
   // (pemain wajib "mengintai" dgn 1 bidak dulu sebelum tau isi garnisun tiap wilayah).
   p.hidden=true;

   p.a=Math.PI;pc.push(p);

  }

 }

}



// KAMERA

function b2s(bx,by){return{x:(bx-cam.x)*cam.z+cv.width/2+shX,y:(by-cam.y)*cam.z+cv.height/2+shY}}

function s2b(sx,sy){return{x:(sx-cv.width/2-shX)/cam.z+cam.x,y:(sy-cv.height/2-shY)/cam.z+cam.y}}



// UTIL

function ds(a,b){var dx=a.x-b.x,dy=a.y-b.y;return Math.sqrt(dx*dx+dy*dy)}

function aT(f,t){return Math.atan2(t.y-f.y,t.x-f.x)}

function nA(a){while(a>Math.PI)a-=2*Math.PI;while(a<-Math.PI)a+=2*Math.PI;return a}

function iF(p,o){return Math.abs(nA(aT(p,o)-p.a))<FH}

function iB(p,o){return Math.abs(nA(aT(p,o)-p.a-Math.PI))<FH}

function iFM(m,t){return Math.abs(nA(aT(t,m)-t.a))<FH}

// Zona 4-arah: posisi 'p' dilihat dari orientasi 'tgt' (arah hadap tgt.a), dibagi 4 kuadran 90 derajat

// Return: "FL" depan-kiri, "FR" depan-kanan, "BL" belakang-kiri, "BR" belakang-kanan

function zoneOf(tgt,p){

 var rel=nA(aT(tgt,p)-tgt.a); // sudut posisi p relatif arah hadap tgt: 0=tepat depan, PI/-PI=tepat belakang

 var front=Math.abs(rel)<Math.PI/2;

 var left=rel<0; // sisi kiri tgt (berdasar konvensi sudut layar: y ke bawah, jadi rel negatif = kiri)

 if(front)return left?"FL":"FR";

 return left?"BL":"BR";

}

function isFrontZone(z){return z==="FL"||z==="FR"}
function isBackZone(z){return z==="BL"||z==="BR"}
function sM(x,y){return zoneSpd(x,y)*sM0(x,y)}
function sM0(x,y){return isWater(x,y)?WATER_SPD:1}

// Bidak "berlabuh" (anchored): TIDAK BOLEH bergerak mengejar/orbit musuh sama sekali, cuma
// boleh berputar di tempat utk menghadap & menyerang. Dua kasus: (1) bidak formasi yg sudah
// sampai di slotnya, (2) bidak mode GoTo (obey) yg sudah tiba di tujuan (ord bukan "move" lagi).
function isAnchored(p){
 if(p.t!=="p"&&!p.cmd)return false;
 if(p.form&&p.formAng!=null){
  var dX=p.gtx+p.ox,dY=p.gty+p.oy;
  if(ds(p,{x:dX,y:dY})<=SR*1.2)return true;
 }
 if(p.obey&&p.ord!=="move")return true;
 return false;
}

// === SPATIAL GRID (optimasi pencarian tetangga, biar tak perlu O(n^2) cek semua bidak ke semua bidak) ===
var GCELL=100; // sel utk akuisisi/backstab (radius deteksi lumayan besar: AR/BDR)
var CCELL=40; // sel lebih rapat khusus collision (radius sangat kecil: COLR) - kurangi kandidat per sel di kerumunan padat
function buildGrid(arr,cell){
 var g={};
 for(var i=0;i<arr.length;i++){
  var p=arr[i];
  var key=(Math.floor(p.x/cell)*100000)+Math.floor(p.y/cell);
  var b=g[key];if(!b){b=[];g[key]=b}
  b.push(i);
 }
 return g;
}
function queryGrid(g,cell,x,y,radius,out){
 out.length=0;
 var cr=Math.max(1,Math.ceil(radius/cell));
 var ccx=Math.floor(x/cell),ccy=Math.floor(y/cell);
 for(var dx=-cr;dx<=cr;dx++){
  var bx=(ccx+dx)*100000;
  for(var dy=-cr;dy<=cr;dy++){
   var b=g[bx+(ccy+dy)];
   if(b)for(var k=0;k<b.length;k++)out.push(b[k]);
  }
 }
 return out;
}

function fN(p){

 var b=null,bd=1e9;

 for(var i=0;i<pc.length;i++){var o=pc[i];if(!o.al||o.t===p.t)continue;var d=ds(p,o);if(d<bd){bd=d;b=o}}

 return b;

}



// SELEKSI

function sRx(x0,y0,x1,y1){

 var lx=Math.min(x0,x1),ly=Math.min(y0,y1),rx=Math.max(x0,x1),ry=Math.max(y0,y1);

 sel.clear();

 for(var i=0;i<pc.length;i++){var p=pc[i];if(!p.al||p.t!=="p"||p.owner!==mpMyOwner)continue;if(p.x>=lx&&p.x<=rx&&p.y>=ly&&p.y<=ry)sel.add(i)}

 uSI();

}

function uSI(){document.getElementById("sC").textContent=sel.size}



// PERINTAH

var gidC=1;

function spatialKeyOfSlot(s,mode){
 // Kunci urutan SPASIAL sebuah slot (bukan prioritas kedalaman) - dipakai utk urutan akhir output,
 // supaya pairing dgn bidak yg diurutkan spasial (spatialSortKey) tetap konsisten & tak mengacak barisan.
 if(mode==="simplex"||mode==="duplex"){
  var horiz=mode==="simplex"?(simplexOri%2===0):(duplexOri%2===0);
  return horiz?s.ox:s.oy;
 }
 if(mode==="vshape")return Math.sqrt(s.ox*s.ox+s.oy*s.oy); // sepanjang lengan: tip(0)->ujung(jauh)
 return Math.atan2(s.oy,s.ox); // globus: urut berdasar sudut sekitar pusat
}

function globusHoleCount(rings){
 // Jumlah slot globus yg perlu dikosongkan di tengah spy jendral (2.2x ukuran bidak) muat,
 // menghitung "rings" baris (ring 0 = titik pusat, ring 1..rings-1 = cincin di sekitarnya).
 var gap=PR*2.4,cnt=1;
 for(var ring=1;ring<rings;ring++){
  var rad=ring*gap;
  cnt+=Math.max(6,Math.round(Math.PI*2*rad/gap));
 }
 return cnt;
}

function fmtOffsets(n,mode,holeCount){

 // Kembalikan array {ox,oy,ang} offset relatif thd centroid utk n bidak, sesuai formasi aktif.

 // ang (opsional) = arah hadap yg dipaksakan formasi (null = auto-face arah gerak seperti biasa)

 // holeCount (opsional, globus saja) = jumlah slot TERDEKAT ke pusat yg DILEWATI/dikosongkan (mis. utk
 // beri ruang jendral berdiri di tengah) - slot yg dipilih tetap n slot berikutnya SETELAH lubang itu,
 // shg bentuknya tetap lingkaran padat (cuma ada lubang bundar di pusatnya), bukan sepotong wedge hilang.

 // PRINSIP 2 TAHAP: (1) bangun pool slot besar dgn prioritas KEDALAMAN (jarak/langkah ke pusat formasi),

 // pilih n slot dgn prioritas tertinggi (tengah dulu) - ini yg bikin slot hilang konsisten di pinggir saat

 // n mengecil. (2) Urutkan HASIL n slot itu scr SPASIAL (kiri->kanan / sudut), BUKAN dari prioritas tsb -

 // supaya saat dipasangkan index-ke-index dgn bidak yg jg diurutkan spasial, barisan yg sudah rapi tak acak

 // (bidak ujung kiri sekarang tetap ujung kiri sesudahnya, cuma jarak antar-bidak yg menyesuaikan).

 var gap=PR*2.4;

 holeCount=holeCount||0;

 if(mode==="globus"){

  var slots=[];

  slots.push({ox:0,oy:0,ang:0});

  var ring=1;

  while(slots.length<n+holeCount+40){ // buat cukup banyak ring cadangan (+lubang tengah bila ada)

   var rad=ring*gap;

   var cnt=Math.max(6,Math.round(Math.PI*2*rad/gap));

   for(var k=0;k<cnt;k++){

    var ang=(Math.PI*2*k)/cnt;

    slots.push({ox:Math.cos(ang)*rad,oy:Math.sin(ang)*rad,ang:ang});

   }

   ring++;

   if(ring>80)break;

  }

  slots.sort(function(a,b){return (a.ox*a.ox+a.oy*a.oy)-(b.ox*b.ox+b.oy*b.oy)});

  var picked=slots.slice(holeCount,holeCount+n); // lewati holeCount slot terdekat pusat (lubang bundar), baru ambil n slot berikutnya

  picked.sort(function(a,b){return spatialKeyOfSlot(a,mode)-spatialKeyOfSlot(b,mode)});

  return picked;

 }

 if(mode==="simplex"||mode==="duplex"){

  var lines=mode==="simplex"?1:2;

  var horiz=mode==="simplex"?(simplexOri%2===0):(duplexOri%2===0);

  var maxPerLine=Math.ceil(n/lines)+30;

  var slots=[];

  for(var line=0;line<lines;line++){

   var lineOff=(line-(lines-1)/2)*gap*1.8;

   for(var pos=0;pos<maxPerLine;pos++){

    // Susun posisi dari TENGAH garis ke luar: 0,+1,-1,+2,-2,... (dipakai utk PRIORITAS pemilihan slot)

    var k=Math.ceil(pos/2)*(pos%2===0?1:-1);

    var along=k*gap;

    var ox,oy;

    if(horiz){ox=along;oy=lineOff}else{ox=lineOff;oy=along}

    slots.push({ox:ox,oy:oy,ang:null,d2:along*along});

   }

  }

  // Urutkan tiap garis sudah dari tengah, tapi utk multi-garis (duplex) gabungkan berselang-seling

  // agar kedua garis terisi merata dari tengah dulu, bukan garis 1 penuh baru garis 2.

  var byLine=[];for(var line=0;line<lines;line++)byLine.push(slots.filter(function(s,idx){return Math.floor(idx/maxPerLine)===line}));

  var picked=[];var idxs2=new Array(lines).fill(0);

  while(picked.length<n){

   for(var line=0;line<lines&&picked.length<n;line++){

    if(idxs2[line]<byLine[line].length){picked.push(byLine[line][idxs2[line]]);idxs2[line]++}

   }

  }

  // Tahap 2: urutkan ULANG hasil scr spasial murni per-garis, spy pairing dgn bidak (jg diurut spasial per sisi kiri/kanan garis) konsisten.

  // Untuk duplex, kelompokkan per garis (berdasar lineOff) lalu urutkan tiap grup spasial & gabungkan garis1 lalu garis2 scr berurutan posisi.

  picked.sort(function(a,b){

   var la=(horiz?a.oy:a.ox),lb=(horiz?b.oy:b.ox); // baris/garis mana (offset tegak lurus sumbu)

   if(la!==lb)return la-lb;

   return spatialKeyOfSlot(a,mode)-spatialKeyOfSlot(b,mode);

  });

  return picked;

 }

 if(mode==="vshape"){

  var rot=[0,Math.PI/2,Math.PI,-Math.PI/2][vshapeDir%4];

  var cs=Math.cos(rot),sn=Math.sin(rot);

  var maxPos=Math.ceil(n/2)+30;

  var slots=[];

  slots.push({lx:0,ly:0});

  for(var pos=1;pos<maxPos;pos++){

   var along=pos*gap*0.85,spread=pos*gap*0.85;

   slots.push({lx:-along,ly:spread}); // lengan atas

   slots.push({lx:-along,ly:-spread}); // lengan bawah

  }

  slots.sort(function(a,b){return (a.lx*a.lx+a.ly*a.ly)-(b.lx*b.lx+b.ly*b.ly)});

  var picked=slots.slice(0,n).map(function(s){

   var ox=s.lx*cs-s.ly*sn,oy=s.lx*sn+s.ly*cs;

   return {ox:ox,oy:oy,ang:null,lside:s.ly};

  });

  // Tahap 2: urutkan ULANG scr spasial per-lengan (biar barisan tiap lengan tetap runtut & tak acak),

  // lengan atas (ly>0) duluan lalu lengan bawah (ly<0), masing2 diurut dari tip ke ujung.

  picked.sort(function(a,b){

   var sa=a.lside>=0?0:1,sb=b.lside>=0?0:1;

   if(sa!==sb)return sa-sb;

   return spatialKeyOfSlot(a,mode)-spatialKeyOfSlot(b,mode);

  });

  return picked;

 }

 return null;

}

function spatialSortKey(p,cx0,cy0,mode){
 // Kunci urutan spasial bidak RELATIF thd centroid grup, dipakai HANYA SEKALI saat formasi baru dibuat
 // (gid baru) utk menentukan slotIdx awal tiap bidak (posisi kiri->kanan / sudut / lengan, dst).
 if(mode==="simplex"||mode==="duplex"){
  var horiz=mode==="simplex"?(simplexOri%2===0):(duplexOri%2===0);
  var lineAxis=horiz?(p.y-cy0):(p.x-cx0); // sisi/garis mana
  var along=horiz?(p.x-cx0):(p.y-cy0);
  return lineAxis*100000+along; // urutkan per-garis dulu, baru posisi di sepanjang garis
 }
 if(mode==="vshape"){
  var side=(p.y-cy0)>=0?0:1; // lengan atas / bawah relatif centroid
  var d=Math.hypot(p.x-cx0,p.y-cy0);
  return side*1000000+d;
 }
 // globus: urutkan berdasar sudut di sekitar centroid (biar barisan melingkar tetap runtut)
 return Math.atan2(p.y-cy0,p.x-cx0);
}

function orderMove(bx,by){

 if(sel.size===0)return;

 if(!mpIsHost){
  // CLIENT: jangan eksekusi formasi/gid lokal (state itu cuma valid & konsisten di host). Kirim
  // idx yg diseleksi + parameter (formMode/moveMode) ke host, host yg panggil orderMove() aslinya.
  mpSendOrApplyInput("orderMove",{ids:Array.from(sel),bx:bx,by:by,formMode:formMode,moveMode:moveMode});
  return;
 }

 var idxs=Array.from(sel);
 var gIdx=-1;
 var myGenIdx=(typeof __cmdOwner==="number"&&pgens[__cmdOwner])?pc.indexOf(pgens[__cmdOwner]):pgenIdx;
 var myGenMode=(typeof __cmdGenMode==="string")?__cmdGenMode:genMode;
 if(formMode&&idxs.length>1){var gi=idxs.indexOf(myGenIdx);if(gi>=0){gIdx=myGenIdx;idxs.splice(gi,1)}}
 var gK=(gIdx>=0&&formMode==="globus"&&myGenMode==="tengah")?Math.min(globusHoleCount(3),30):0;
 var offs=formMode?fmtOffsets(idxs.length,formMode,gK):null;

 if(!offs){

  // Tanpa formasi khusus: pertahankan bentuk relatif skrg thd centroid (perilaku lama)

  var cx0=0,cy0=0;

  for(var k=0;k<idxs.length;k++){cx0+=pc[idxs[k]].x;cy0+=pc[idxs[k]].y}

  cx0/=idxs.length;cy0/=idxs.length;

  offs=[];

  for(var k=0;k<idxs.length;k++){var p=pc[idxs[k]];offs.push({ox:p.x-cx0,oy:p.y-cy0,ang:null})}

 }else{

  // Cek apakah SELEKSI SEKARANG adalah grup formasi yg SAMA PERSIS dgn order sebelumnya (semua bidak

  // terpilih share gid lama yg sama & mode formasi yg sama) - kalau ya, ini cuma "gerak lanjutan" grup

  // yg sama, jadi label posisi (slotIdx) LAMA dipertahankan (tengah tetap tengah, dst, tak di-re-label).

  // Kalau seleksi beda (bidak baru ditambah/dikurangi manual, atau formasi baru pertama kali dipilih),

  // baru label DIBUAT ULANG dari urutan spasial sekarang.

  var sameGroup=true;

  var refGid=pc[idxs[0]].gid;

  for(var k=0;k<idxs.length;k++){

   var p=pc[idxs[k]];

   if(p.form!==formMode||p.gid!==refGid||!p.gid){sameGroup=false;break}

  }

  if(sameGroup){

   // Pastikan tak ada slotIdx bentrok/di luar range n (mis. drift dr reflow) - kalau valid, pakai langsung.

   var seen={};var valid=true;

   for(var k=0;k<idxs.length;k++){

    var si=pc[idxs[k]].slotIdx;

    if(si==null||si<0||si>=idxs.length||seen[si]){valid=false;break}

    seen[si]=true;

   }

   if(!valid)sameGroup=false;

  }

  if(!sameGroup){

   var cx0=0,cy0=0;

   for(var k=0;k<idxs.length;k++){cx0+=pc[idxs[k]].x;cy0+=pc[idxs[k]].y}

   cx0/=idxs.length;cy0/=idxs.length;

   idxs.sort(function(a,b){return spatialSortKey(pc[a],cx0,cy0,formMode)-spatialSortKey(pc[b],cx0,cy0,formMode)});

   for(var k=0;k<idxs.length;k++)pc[idxs[k]].slotIdx=k;

  }

 }

 var gid=gidC++;

 var isGoto=(moveMode==="goto");

 for(var k=0;k<idxs.length;k++){

  var p=pc[idxs[k]];

  p.obey=isGoto; // GoTo=jalan mutlak tak auto-target baru, tapi tetap bisa damage musuh yg menghalangi di depan; Serang=auto-target sambil jalan

  p.ord="move";p.tgt=null;p.zone=null;p.eng=null;p.rt=false;p.rtW=false;p.orbiting=null;p.gotoBlock=false;

  var slotK=formMode?p.slotIdx:k;

  p.ox=offs[slotK].ox;p.oy=offs[slotK].oy;

  p.gtx=bx;p.gty=by;p.gid=gid;

  p.form=formMode;p.formAng=offs[slotK].ang;

 }

 if(formMode)gidCount[gid]=idxs.length;

 // Jendral ikut perintah sbg anggota biasa (dipilih sendirian, atau formMode blm memenuhi syarat slot
 // khusus di atas) - baseGtx/baseGty WAJIB disegarkan ke tujuan baru ini, kalau tidak SIAGA runtime tiap
 // frame bakal nimpa balik ke posisi lama (bug: jendral kelihatan macet/stuck tak mau jalan saat dipilih sendiri).
 if(gIdx<0&&idxs.indexOf(myGenIdx)>=0){
  var g2=pc[myGenIdx];
  g2.baseGtx=bx;g2.baseGty=by;g2.gotoOrder=isGoto;g2.formSnap=null;g2.genModeSnap=null;
 }

 if(gIdx>=0){ // jenderal: dapat slot sendiri di grup formasi (bukan individu terpisah), posisi sesuai tombol "Jendral: ..."
  var g=pc[gIdx];
  var gox=0,goy=0;
  if(myGenMode!=="tengah"){
   // Cari bounding box slot2 bidak (offs, relatif thd titik tujuan bx,by) utk taruh jendral di LUAR barisan
   var minOx=1e9,maxOx=-1e9,minOy=1e9,maxOy=-1e9;
   for(var k=0;k<offs.length;k++){
    if(offs[k].ox<minOx)minOx=offs[k].ox;
    if(offs[k].ox>maxOx)maxOx=offs[k].ox;
    if(offs[k].oy<minOy)minOy=offs[k].oy;
    if(offs[k].oy>maxOy)maxOy=offs[k].oy;
   }
   if(offs.length===0){minOx=maxOx=minOy=maxOy=0}
   var margin=PR*4.5;
   if(myGenMode==="kiri"){gox=minOx-margin;goy=(minOy+maxOy)/2}
   else if(myGenMode==="kanan"){gox=maxOx+margin;goy=(minOy+maxOy)/2}
   else if(myGenMode==="atas"){goy=minOy-margin;gox=(minOx+maxOx)/2}
   else if(myGenMode==="bawah"){goy=maxOy+margin;gox=(minOx+maxOx)/2}
  }
  g.obey=true;g.ord="move";g.tgt=null;g.zone=null;g.eng=null;g.rt=false;g.orbiting=null;g.gotoBlock=false;
  g.form=null;g.gid=gid;g.ox=0;g.oy=0;g.gtx=bx+gox;g.gty=by+goy;
  g.baseGtx=g.gtx;g.baseGty=g.gty; // target dasar formasi, dipakai utk balik lagi setelah jendral selesai siaga/sembunyi
  // Snapshot mode formasi/genMode/GoTo saat perintah ini diberikan - dipakai SIAGA runtime utk tahu
  // apakah jendral skrg "terlindungi penuh" (globus+tengah = terkurung 360° bidak sendiri) atau
  // sedang GoTo (wajib patuh lurus spt bidak biasa, tak boleh kabur menyimpang formasi/barisan).
  g.formSnap=formMode;g.genModeSnap=myGenMode;g.gotoOrder=isGoto;
 }
 for(var k=0;k<idxs.length;k++)pc[idxs[k]].kx=gK;
 var modeTxt=isGoto?"GoTo":"Serang";

 var formTxt=formMode?(" ["+formMode+"]"):"";

 tK(idxs.length+" bidak: Bergerak ("+modeTxt+")"+formTxt);

}

function tK(m){var t=document.createElement("div");t.className="tk";t.textContent=m;document.body.appendChild(t);setTimeout(function(){t.remove()},2500)}



function sSp(s){

 if(s===0)pau=!pau;

 document.getElementById("bP").classList.toggle("ac",pau);

}



// TOMBOL

document.getElementById("bP").onclick=function(){sSp(0)};





function setMoveMode(m){
 moveMode=m;
 document.getElementById("bAtk").classList.toggle("ac",m==="atk");
 document.getElementById("bGoto").classList.toggle("ac",m==="goto");
}
setMoveMode("atk");
document.getElementById("bAtk").onclick=function(){setMoveMode("atk")};
document.getElementById("bGoto").onclick=function(){setMoveMode("goto")};

function setFormMode(m){
 if(formMode===m&&m!==null){
  // Tekan formasi yg sama lagi: toggle orientasi/arah internal (utk simplex/duplex/vshape), tetap aktif
  if(m==="simplex")simplexOri=(simplexOri+1)%2;
  if(m==="duplex")duplexOri=(duplexOri+1)%2;
  if(m==="vshape")vshapeDir=(vshapeDir+1)%4;
 }else{
  formMode=m;
 }
 document.getElementById("bGlobus").classList.toggle("ac",formMode==="globus");
 document.getElementById("bSimplex").classList.toggle("ac",formMode==="simplex");
 document.getElementById("bDuplex").classList.toggle("ac",formMode==="duplex");
 document.getElementById("bVsh").classList.toggle("ac",formMode==="vshape");
 document.getElementById("bFree").classList.toggle("ac",formMode===null);
 var nm={globus:"Globus",simplex:"Acies Simplex ("+(simplexOri%2===0?"H":"V")+")",duplex:"Acies Duplex ("+(duplexOri%2===0?"H":"V")+")",vshape:"V-Shape ("+["Kanan","Bawah","Kiri","Atas"][vshapeDir%4]+")",null:"Free (bentuk bebas, tanpa formasi)"}[formMode];
 if(nm)tK("Formasi: "+nm);
}
document.getElementById("bGlobus").onclick=function(){setFormMode("globus")};
document.getElementById("bSimplex").onclick=function(){setFormMode("simplex")};
document.getElementById("bDuplex").onclick=function(){setFormMode("duplex")};
document.getElementById("bVsh").onclick=function(){setFormMode("vshape")};
document.getElementById("bFree").onclick=function(){setFormMode(null)};
setFormMode(null); // state awal: Free aktif (tanpa formasi), sinkronkan highlight tombol

function capWord(s){return s.charAt(0).toUpperCase()+s.slice(1)}
function updateGenModeBtn(){document.getElementById("bJendral").textContent="Jendral: "+capWord(genMode)}
function cycleGenMode(){
 genModeIdx=(genModeIdx+1)%genModes.length;
 genMode=genModes[genModeIdx];
 updateGenModeBtn();
 tK("Jendral: "+capWord(genMode));
}
document.getElementById("bJendral").onclick=cycleGenMode;
updateGenModeBtn();



// TOUCH

var tch=[],panS=null,pD=0;



cv.addEventListener("touchstart",function(e){

 e.preventDefault();

 for(var i=0;i<e.changedTouches.length;i++){

  var ct=e.changedTouches[i];

  tch.push({id:ct.identifier,x:ct.clientX,y:ct.clientY});

 }

 if(tch.length===1){

  var bp=s2b(tch[0].x,tch[0].y);

  drag={x0:bp.x,y0:bp.y,x1:bp.x,y1:bp.y};

 }

 if(tch.length===2){

  panS={x:cam.x,y:cam.y,tx:(tch[0].x+tch[1].x)/2,ty:(tch[0].y+tch[1].y)/2};

  pD=Math.hypot(tch[0].x-tch[1].x,tch[0].y-tch[1].y);

  drag=null;

 }

},{passive:false});



cv.addEventListener("touchmove",function(e){

 e.preventDefault();

 for(var i=0;i<e.changedTouches.length;i++){

  var ct=e.changedTouches[i];

  for(var j=0;j<tch.length;j++){if(tch[j].id===ct.identifier){tch[j].x=ct.clientX;tch[j].y=ct.clientY;break}}

 }

 if(tch.length===1&&drag){var bp=s2b(tch[0].x,tch[0].y);drag.x1=bp.x;drag.y1=bp.y}

 if(tch.length===2&&panS){

  var mx2=(tch[0].x+tch[1].x)/2,my2=(tch[0].y+tch[1].y)/2;

  cam.x=panS.x-(mx2-panS.tx)/cam.z;

  cam.y=panS.y-(my2-panS.ty)/cam.z;

  var nd=Math.hypot(tch[0].x-tch[1].x,tch[0].y-tch[1].y);

  if(pD>0){cam.z=Math.max(0.2,Math.min(2.5,cam.z*(nd/pD)));pD=nd}

 }

},{passive:false});



cv.addEventListener("touchend",function(e){

 e.preventDefault();

 if(tch.length===1&&drag){

  var dx=Math.abs(drag.x1-drag.x0),dy=Math.abs(drag.y1-drag.y0);

  if(dx>5||dy>5){

   sRx(drag.x0,drag.y0,drag.x1,drag.y1);

  }else{

   // Tap singkat di titik manapun (kosong atau di atas bidak apapun) = perintah jalan ke titik itu

   orderMove(drag.x0,drag.y0);

  }

  drag=null;

 }

 for(var i=0;i<e.changedTouches.length;i++){

  for(var j=0;j<tch.length;j++){if(tch[j].id===e.changedTouches[i].identifier){tch.splice(j,1);break}}

 }

 if(tch.length<2){panS=null;pD=0}

},{passive:false});



// KEYBOARD (untuk emulator)

var keys=new Set();

document.addEventListener("keydown",function(e){

 keys.add(e.code);

 if(e.code==="Escape"){sel.clear();uSI();setFormMode(null)}

 if(e.key==="o"||e.key==="O")setFormMode("globus");

 if(e.key==="-"||e.code==="Minus"||e.code==="NumpadSubtract")setFormMode("simplex");

 if(e.key==="="||e.code==="Equal"||e.code==="NumpadAdd")setFormMode("duplex");

 if(e.key==="v"||e.key==="V")setFormMode("vshape");

 if(e.key==="f"||e.key==="F")setFormMode(null);

});

document.addEventListener("keyup",function(e){keys.delete(e.code)});



// PARTIKEL

function sP(x,y,tp){

 var n=tp==="d"?10:4;

 for(var i=0;i<n;i++){

  var a=Math.random()*Math.PI*2,s=tp==="d"?30+Math.random()*50:15+Math.random()*25;

  pt.push({x:x,y:y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,lf:0.3+Math.random()*0.3,ml:0.3+Math.random()*0.3,sz:tp==="d"?2+Math.random()*2.5:1.5,cl:tp==="d"?(Math.random()>0.5?"#ff4444":"#ff8833"):"#ffdd66"});

 }

}



// UPDATE

var COLR=PR*2; // diameter bidak - jarak minimum agar tidak saling menembus

// === KOMANDAN MUSUH: informan lapor -> jenderal aktif memimpin formasi & melihat semua bidak pemain ===
var CMDF={globus:"Globus",simplex:"Acies Simplex",duplex:"Acies Duplex",vshape:"V-Shape"};
function leadStart(te,t){
 te.st="lead";te.cT=9;
 if(te.runner){te.runner.runner=false;te.runner=null}
 for(var qi=0;qi<pc.length;qi++){var q=pc[qi];if(q.t==="e"&&q.i===t&&q.al){q.role="atk";q.cmd=true}}
 tK('Jenderal '+te.rl+' dari '+te.nm+' memimpin pasukan ('+CMDF[te.form]+')!');
}
var fug=[];
var MAX_FLEE_DIST=4200; // batas jarak kabur jenderal - kalau tak ada tetangga hidup dlm radius ini, jendral bertahan di tempat drpd nyebrang jauh ke ujung map
function tcen(te){if(!te._c){var sx=0,sy=0;for(var i=0;i<te.poly.length;i++){sx+=te.poly[i][0];sy+=te.poly[i][1]}te._c={x:sx/te.poly.length,y:sy/te.poly.length}}return te._c}
function fleeGen(te,gn){ // pasukan habis: jenderal kabur ke wilayah jendral TETANGGA (dekat) terdekat, cari aliansi
 var best=null,bd=1e9;
 for(var u=0;u<tr.length;u++){var t2=tr[u];if(t2===te||t2.tm==="p"||!t2.gp||!t2.gp.al||(t2.gp2&&t2.gp2.al))continue;var c=tcen(t2),d=Math.hypot(c.x-gn.x,c.y-gn.y);if(d<bd){bd=d;best=u}}
 if(best===null||bd>MAX_FLEE_DIST)return; // tak ada tetangga dekat yg valid - jendral tetap di posisinya (bertahan)
 if(te.gp===gn)te.gp=null;if(te.gp2===gn)te.gp2=null;
 gn.i=best;gn.cmd=true;gn.obey=true;gn.form=null;gn.hidden=false;
 fug.push({g:gn,d:best,from:te});
}
function cmdTick(dt){
 var P=null;
 for(var f=fug.length-1;f>=0;f--){
  var fr=fug[f],gn=fr.g,d2=tr[fr.d];
  if(!gn.al){fug.splice(f,1);continue}
  // Tuju jendral hidup di wilayah tujuan (bukan cuma titik tengah wilayah) - biar benar2 "menyentuh" jendralnya
  var g2=(d2.gp&&d2.gp.al)?d2.gp:((d2.gp2&&d2.gp2.al&&d2.gp2!==gn)?d2.gp2:null),tp=g2||tcen(d2);
  gn.ord="move";gn.gtx=tp.x;gn.gty=tp.y;gn.ox=0;gn.oy=0;gn.i=fr.d;
  var touched=g2&&ds(gn,g2)<=PR*4.4;
  if(touched||(!g2&&pip(d2.poly,gn.x,gn.y))){
   if(!d2.gp2||!d2.gp2.al){ // ALIANSI: jendral kabur resmi jd jendral ke-2 wilayah tujuan, & wilayah itu lgsg aktif bareng
    d2.gp2=gn;gn.cmd=true;gn.role="atk";gn.obey=true;
    tK('Jenderal '+fr.from.rl+' dari '+fr.from.nm+' beraliansi dgn wilayah '+d2.nm+'!');
    if(d2.st!=="lead")leadStart(d2,fr.d);
   }else{ // slot ke-2 keburu terisi (race) - tetap gabung diam2 sbg cadangan tersembunyi
    gn.hidden=true;gn.ord=null;gn.cmd=false;
   }
   fug.splice(f,1);continue;
  }
 }
 for(var t=0;t<tr.length;t++){
  var te=tr[t];if(te.revealed)te.ever=true;
  var gens=[];if(te.gp&&te.gp.al)gens.push(te.gp);if(te.gp2&&te.gp2.al&&!te.gp2.hidden)gens.push(te.gp2);
  var g=gens[0];
  if(te.tm==="p"||!g||!te.revealed)continue;
  te.cT=(te.cT||0)+dt;if(te.cT<0.3)continue;te.cT=0;
  if(!P){P=[];for(var i=0;i<pc.length;i++)if(pc[i].t==="p"&&pc[i].al)P.push(pc[i])}
  if(!P.length)continue;
  var mem=[];
  for(var i=0;i<pc.length;i++){var q=pc[i];if(q.t==="e"&&q.i===t&&q.al&&!q.hidden&&!q.gen)mem.push(q)}
  if(te.st!=="lead"){
   var spot=null,sd=1e9,all=mem.concat(gens);
   for(var i=0;i<all.length;i++)for(var j=0;j<P.length;j++){var d=ds(all[i],P[j]);if(d<AR*1.15&&d<sd){sd=d;spot=all[i]}}
   if(te.runner&&(!te.runner.al||te.runner.t!=="e"))te.runner=null;
   if(spot&&spot.gen)leadStart(te,t);
   else if(spot&&!te.runner){ // 1 bidak (prioritas informan terdekat) kabur ke jenderal
    var best=null,bd=1e9;
    for(var i=0;i<mem.length;i++){if(mem[i].role!=="inf")continue;var d=ds(mem[i],spot);if(d<bd){bd=d;best=mem[i]}}
    if(!best)best=spot;
    te.runner=best;best.runner=true;best.cmd=true;best.obey=true;best.form=null;
   }
   if(te.runner){var r=te.runner;r.ord="move";r.gtx=g.x;r.gty=g.y;r.ox=0;r.oy=0;r.tgt=null;r.zone=null;if(ds(r,g)<PR*3.6)leadStart(te,t)}
   if(te.st!=="lead")continue;
  }
  if(!mem.length){for(var gi=0;gi<gens.length;gi++)fleeGen(te,gens[gi]);continue}
  var n=mem.length,ex=0,ey=0;
  for(var i=0;i<n;i++){ex+=mem[i].x;ey+=mem[i].y}
  ex/=n;ey/=n;
  var T=null,td=1e9; // jenderal melihat SEMUA bidak pemain, berapapun jaraknya
  for(var j=0;j<P.length;j++){var d=Math.hypot(P[j].x-ex,P[j].y-ey);if(d<td){td=d;T=P[j]}}
  var dx=T.x-ex,dy=T.y-ey,D=td||1,ux=dx/D,uy=dy/D,ang=Math.atan2(dy,dx);
  var dom=te.dom;
  if(!dom||(dom==="x"&&Math.abs(dy)>Math.abs(dx)*1.3)||(dom==="y"&&Math.abs(dx)>Math.abs(dy)*1.3))dom=Math.abs(dx)>=Math.abs(dy)?"x":"y";
  te.dom=dom;
  var vd=dom==="x"?(dx>=0?0:2):(dy>=0?1:3),mode=te.form,key=mode+dom+vd+n+gens.length;
  var so=simplexOri,dO=duplexOri,sv=vshapeDir;
  simplexOri=duplexOri=(dom==="x"?1:0);vshapeDir=vd; // garis tegak lurus arah ancaman, ujung V menghadap ancaman
  if(te.fkey!==key){
   te.fkey=key;
   var K=(mode==="globus")?6*gens.length:0,offs=fmtOffsets(n,mode,K);
   if(offs){
    mem.sort(function(a,b){return spatialSortKey(a,ex,ey,mode)-spatialSortKey(b,ex,ey,mode)});
    for(var k=0;k<n;k++){mem[k].slotIdx=k;mem[k].ox=offs[k].ox;mem[k].oy=offs[k].oy;mem[k].formAng=offs[k].ang}
   }
  }
  simplexOri=so;duplexOri=dO;vshapeDir=sv;
  var stand=PR*2.4*(Math.sqrt(n)*0.6+1),mv=Math.max(0,Math.min(70,D-stand));
  var fx=ex+ux*mv,fy=ey+uy*mv,bh=Math.max(50,PR*2.4*(Math.sqrt(n)/2+2));
  for(var k=0;k<n;k++){var m=mem[k];m.cmd=true;m.obey=false;m.form=mode;m.gid=0;m.ord="move";m.role="atk";m.gtx=fx;m.gty=fy;if(mode!=="globus")m.formAng=ang}
  for(var gi=0;gi<gens.length;gi++){ // globus: jenderal di tengah; formasi lain: di belakang barisan
   var gg=gens[gi],lat=(gi-(gens.length-1)/2)*PR*4.6,bk=(mode==="globus")?0:bh;
   gg.cmd=true;gg.obey=true;gg.ord="move";gg.form=null;gg.ox=0;gg.oy=0;gg.gtx=fx-ux*bk-uy*lat;gg.gty=fy-uy*bk+ux*lat;
  }
 }
}
// === KONDISI WILAYAH: zona bahaya/bantuan diundi acak tiap permainan baru ===
var hz=null,zT=0;
// Warna: lumpur=coklat, air=biru cerah keputihan (kesan air suci). Api tak pakai warna statis -
// dianimasikan (lihat drawZone) jadi ZC/ZS.api cuma fallback kalau dibutuhkan di tempat lain.
var ZC={lumpur:"rgba(101,67,33,.5)",api:"rgba(255,100,20,.4)",air:"rgba(200,244,255,.55)"},ZS={lumpur:"#6b4423",api:"#ff7a1a",air:"#eafcff"};
function mkBlob(cx0,cy0,r){
 // Bentuk kolam/genangan organik: poligon banyak sisi dgn radius acak per sudut, nanti
 // dirender dgn kurva halus (drawBlob) shg tak ada sudut tajam - bukan lingkaran sempurna.
 var sides=8+Math.floor(Math.random()*5),pts=[];
 for(var k=0;k<sides;k++){
  var ang=(Math.PI*2*k)/sides+Math.random()*0.25;
  var rad=r*(0.68+Math.random()*0.58);
  pts.push({x:cx0+Math.cos(ang)*rad,y:cy0+Math.sin(ang)*rad});
 }
 return pts;
}
function drawBlob(cx,pts){
 if(pts.length<3)return;
 var p0=pts[pts.length-1],p1=pts[0];
 cx.beginPath();
 cx.moveTo((p0.x+p1.x)/2,(p0.y+p1.y)/2);
 for(var i=0;i<pts.length;i++){
  var cur=pts[i],nxt=pts[(i+1)%pts.length];
  cx.quadraticCurveTo(cur.x,cur.y,(cur.x+nxt.x)/2,(cur.y+nxt.y)/2);
 }
 cx.closePath();
}
function genZones(){
 hz=[];var HT=["lumpur","api","air"];
 for(var t=0;t<tr.length;t++){
  var te=tr[t];if(Math.random()>0.65)continue; // ~65% wilayah punya kondisi
  var ty=HT[Math.floor(Math.random()*3)],nz=Math.random()<0.4?2:1;
  for(var z=0;z<nz;z++){
   for(var k=0;k<25;k++){
    var pt=(te.nm==="Hutan Sancang")?randPtInPolyMinX(te,2300):randPtInPoly(te),r=((ty==="api"?50:70)+Math.random()*60)*3;
    if(isWater(pt.x,pt.y)||(function(){for(var o=0;o<4;o++){if(pgens[o]&&ds(pt,pgens[o])<400)return true}return false})()||(te.gp&&ds(pt,te.gp)<r+120))continue;
    hz.push({t:ty,x:pt.x,y:pt.y,r:r,poly:mkBlob(pt.x,pt.y,r)});break;
   }
  }
 }
}
function zoneSpd(x,y){
 if(!hz)return 1;
 for(var i=0;i<hz.length;i++){var z=hz[i];if(z.t!=="lumpur")continue;var dx=x-z.x,dy=y-z.y;if(dx*dx+dy*dy<z.r*z.r)return 0.55}
 return 1;
}
function zoneTick(dt,al){
 if(!hz){try{genZones()}catch(e){hz=hz||[]}}
 zT+=dt;if(zT<0.25)return;var d=zT;zT=0;
 for(var i=0;i<hz.length;i++){
  var z=hz[i];if(z.t==="lumpur")continue;var r2=z.r*z.r;
  for(var j=0;j<al.length;j++){
   var p=al[j];if(!p.al)continue;var dx=p.x-z.x,dy=p.y-z.y;
   if(dx*dx+dy*dy>=r2)continue;
   if(z.t==="api"){p.hp-=10*d;p.hf=0.15;if(p.hp<=0){p.hp=0;p.al=false;sP(p.x,p.y,"d")}}
   else{var mh=p.mhp||100;if(p.hp<mh)p.hp=Math.min(mh,p.hp+8*d)}
  }
 }
}
function update(dt){

 if(pau||go)return;

 dt=Math.min(dt*spd,0.075); // cap disesuaikan dgn kecepatan maks baru (SPD_F=3)



 var cs2=300/cam.z*dt;

 if(keys.has("ArrowLeft"))cam.x-=cs2;if(keys.has("ArrowRight"))cam.x+=cs2;

 if(keys.has("ArrowUp"))cam.y-=cs2;if(keys.has("ArrowDown"))cam.y+=cs2;

 cam.x=Math.max(0,Math.min(BW,cam.x));cam.y=Math.max(0,Math.min(BH,cam.y));



 if(shk>0){shk*=0.88;shX=(Math.random()-0.5)*shk;shY=(Math.random()-0.5)*shk;if(shk<0.3){shk=0;shX=0;shY=0}}



 var al=[];

 for(var i=0;i<pc.length;i++)if(pc[i].al&&!pc[i].hidden)al.push(pc[i]);

 for(var i=0;i<al.length;i++)al[i].eng=null;



 // === REFLOW FORMASI: kalau ada bidak formasi (gid sama, form aktif) yg mati sejak reflow terakhir,

 // sisa bidak grup itu di-REINDEX (bukan diurutkan ulang scr posisi baru!). Tiap bidak yg masih hidup

 // MEMPERTAHANKAN urutan relatif slotIdx lama mrk satu sama lain (siapa yg tadinya tengah/kedua/dst tetap

 // di posisi urutan yg sama), cuma nomor slotIdx dimampatkan jadi 0..n-1 berurutan spy tak ada celah -

 // shg slot yg hilang krn kematian selalu di UJUNG label lama, bukan bikin yg tengah malah kepinggir. ===

 var byGid={};

 for(var i=0;i<al.length;i++){

  var p=al[i];

  if(p.t!=="p"||!p.form||!p.gid)continue;

  if(!byGid[p.gid])byGid[p.gid]=[];

  byGid[p.gid].push(p);

 }

 for(var gidKey in byGid){

  var members=byGid[gidKey];

  var n=members.length;

  if(gidCount[gidKey]===n)continue; // tak berubah sejak reflow terakhir, skip

  gidCount[gidKey]=n;

  if(n===0)continue;

  var formMd=members[0].form;

  var kx=members[0].kx||0,offs=fmtOffsets(n,formMd,kx);
  if(!offs)continue;

  // Urutkan HANYA berdasar slotIdx LAMA (label permanen yg sudah ada), bukan posisi fisik baru.

  members.sort(function(a,b){return a.slotIdx-b.slotIdx});

  for(var k=0;k<n;k++){

   members[k].slotIdx=k; // reindex rapat 0..n-1, mempertahankan urutan relatif lama

   members[k].ox=offs[k].ox;members[k].oy=offs[k].oy;members[k].formAng=offs[k].ang;

  }

 }



 // === VALIDASI TARGET LAMA: buang jika target sudah mati ===

 for(var i=0;i<al.length;i++){

  var p=al[i];

  if(p.tgt&&!p.tgt.al){p.tgt=null;p.zone=null;p.gotoBlock=false}

 }



 // === AKUISISI TARGET: bidak tanpa target cari musuh terdekat dlm radius AR (pakai spatial grid) ===

 var pGrid=buildGrid(al,GCELL); // grid posisi saat ini (sblm gerak) - dipakai bareng utk akuisisi & backstab

 var qCand=[];

 for(var i=0;i<al.length;i++){

  var p=al[i];

  if(p.rt||p.tgt)continue; // sedang mundur atau sudah punya target: skip

  if(p.obey&&p.ord==="move")continue; // GoTo yg MASIH JALAN: jangan auto-target baru (biar tak belok2 dr lintasan); sudah tiba (ord!=="move") boleh auto-target spt biasa, tapi nanti tetap tak mengejar (lihat isAnchored)

  var best=null,bestD=AR;

  queryGrid(pGrid,GCELL,p.x,p.y,AR,qCand);

  for(var k=0;k<qCand.length;k++){

   var o=al[qCand[k]];if(o.t===p.t)continue;

   var d=ds(p,o);if(d<bestD){bestD=d;best=o}

  }

  if(best){p.tgt=best;p.zone=null}

 }



 // === GoTo BLOCKING: bidak mode GoTo (p.obey) yg sdg jalan (ord=move, blm py target biasa) tetap boleh menyerang

 // musuh yg SECARA FISIK menghalangi jalur ke tujuan (dekat & ada di depan arah gerak). Beda dari mode Serang:

 // di sini bidak TIDAK mengejar musuh manapun di luar jalurnya, hanya musuh yg nempel di depan lintasannya. ===

 for(var i=0;i<al.length;i++){

  var p=al[i];

  if(p.rt||p.tgt||!p.obey||p.t!=="p"||p.ord!=="move")continue;

  var destX=p.gtx+p.ox,destY=p.gty+p.oy;

  if(ds(p,{x:destX,y:destY})<=4)continue; // sudah nyaris sampai, tak perlu cek blokir

  var best=null,bestD=SR*1.4;

  queryGrid(pGrid,GCELL,p.x,p.y,bestD,qCand);

  var moveAng=aT(p,{x:destX,y:destY});

  for(var k=0;k<qCand.length;k++){

   var o=al[qCand[k]];if(o.t===p.t)continue;

   var d=ds(p,o);if(d>=bestD)continue;

   // musuh harus berada kurang-lebih di depan arah jalan (kerucut sempit), bukan sekadar dekat

   if(Math.abs(nA(aT(p,o)-moveAng))>FH*0.75)continue;

   bestD=d;best=o;

  }

  if(best){p.tgt=best;p.zone=null;p.gotoBlock=true}

 }



 // === PENGALIHAN ANCAMAN: jika ada musuh yg MENARGET diri kita sendiri & musuh itu lebih dekat drpd target kita saat ini, batalkan target lama & langsung lawan ancaman baru tsb (lebih mendesak) ===

 // === PENGALIHAN ANCAMAN: jika ada musuh yg MENARGET diri kita sendiri & musuh itu lebih dekat drpd target kita saat ini, batalkan target lama & langsung lawan ancaman baru tsb (lebih mendesak). Pakai reverse-map (siapa nargetin siapa) O(n), bukan scan semua bidak. ===

 var attackersOf=new Map();

 for(var i=0;i<al.length;i++){

  var o=al[i];if(!o.tgt||o.rt)continue;

  var lst=attackersOf.get(o.tgt);if(!lst){lst=[];attackersOf.set(o.tgt,lst)}

  lst.push(o);

 }

 for(var i=0;i<al.length;i++){

  var p=al[i];if(!p.tgt||p.rt)continue;

  var curD=ds(p,p.tgt);

  var atkers=attackersOf.get(p);if(!atkers)continue;

  var bestThreat=null,bestThreatD=curD;

  for(var k=0;k<atkers.length;k++){

   var o=atkers[k];

   var od=ds(p,o);

   if(od<bestThreatD){bestThreatD=od;bestThreat=o}

  }

  if(bestThreat){p.tgt=bestThreat;p.zone=null;p.orbiting=null}

 }



 // === BACKSTAB: bidak yg SUDAH secara fisik berada di zona belakang seekor musuh (walau blm/beda target) diprioritaskan jadi flanker musuh tsb. Setiap bidak SELALU memprioritaskan target terdekat: kalau slot belakang itu sudah ditempati bidak lain (orbiting ATAU sudah aktif menyerang) tapi kita lebih dekat ke musuh itu, kita gantikan dia (bidak lama dilepas & cari target baru frame berikutnya) ===

 for(var i=0;i<al.length;i++){

  var p=al[i];if(p.rt||p.obey)continue; // sedang mundur atau mode ikut-perintah: jangan rebut target apapun

  var bestE=null,bestED=BDR;

  queryGrid(pGrid,GCELL,p.x,p.y,BDR,qCand);

  for(var k=0;k<qCand.length;k++){

   var e=al[qCand[k]];if(e.t===p.t)continue;

   var d=ds(p,e);if(d>bestED)continue;

   if(!isBackZone(zoneOf(e,p)))continue;

   bestED=d;bestE=e;

  }

  if(!bestE||p.tgt===bestE)continue;

  var slot=zoneOf(bestE,p); // selalu back (sudah difilter isBackZone di atas) - belakang tak terbatas, langsung ambil tanpa cek occupant

  p.tgt=bestE;p.zone=slot;p.orbiting=false;

 }



 // === ASSIGN ZONA: tiap target yg diincar >1 bidak, assign ke 4 zona (FL/FR/BL/BR), maks 1 bidak per zona ===

 var groupsByTgt=new Map();

 for(var i=0;i<al.length;i++){

  var p=al[i];if(!p.tgt||p.rt)continue;

  var key=p.tgt;

  if(!groupsByTgt.has(key))groupsByTgt.set(key,[]);

  groupsByTgt.get(key).push(p);

 }

 groupsByTgt.forEach(function(atkers,tgt){

  // Slot DEPAN (FL/FR) maks 1 bidak masing2 (total 2) - dipertahankan dulu jika sudah mapan.

  // Slot BELAKANG (BL/BR) TAK TERBATAS - semua bidak yg kebagian belakang selalu dipertahankan, tak pernah direbut/dilepas di sini.

  var takenF={FL:null,FR:null};

  var unassigned=[];

  for(var k=0;k<atkers.length;k++){

   var p=atkers[k];

   if(p.zone==="FL"||p.zone==="FR"){

    if(!takenF[p.zone]){takenF[p.zone]=p;continue}

   }else if(p.zone==="BL"||p.zone==="BR"){

    continue; // sudah di belakang, tak terbatas, pertahankan slotnya

   }

   unassigned.push(p);

  }

  // Urutkan sisa berdasar jarak ke target (yg terdekat berhak duluan berebut slot depan)

  unassigned.sort(function(a,b){return ds(a,tgt)-ds(b,tgt)});

  for(var k=0;k<unassigned.length;k++){

   var p=unassigned[k];

   var natural=zoneOf(tgt,p);

   var side=(natural==="FL"||natural==="BL")?"L":"R";

   var frontZone=side==="L"?"FL":"FR",otherFront=side==="L"?"FR":"FL",backZone=side==="L"?"BL":"BR";

   var got;

   if(!takenF[frontZone]){got=frontZone;takenF[got]=p}

   else if(!takenF[otherFront]){got=otherFront;takenF[got]=p}

   else{got=backZone} // kedua slot depan penuh -> selalu kebagian belakang (tak terbatas), tak pernah lepas target

   p.zone=got;p.orbiting=null; // zona baru -> evaluasi ulang orbit dari awal

  }

 });



 // === ORBIT CHECK: flanker (zona belakang) yg BELUM berada di kuadran belakang harus orbit dulu, tidak mendekat ===

 for(var i=0;i<al.length;i++){

  var p=al[i];if(!p.tgt||!p.zone||p.rt)continue;

  if(isBackZone(p.zone)){

   if(p.orbiting!==false){ // null (baru) atau true (masih orbit) -> evaluasi ulang; false (sudah selesai) -> kunci

    var curZone=zoneOf(p.tgt,p);

    p.orbiting=!isBackZone(curZone);

   }

  }else p.orbiting=false;

 }



 // (gangguan flanking kini ditangani oleh blok PENGALIHAN ANCAMAN di atas, yg berlaku umum utk semua bidak)



 // Auto-face: bidak dgn target menghadap ke target (termasuk musuh penghalang saat GoTo); kalau anchor
 // (formasi di slot / GoTo sudah tiba) & tak ada musuh, tetap menghadap arah formasi; sisanya menghadap arah gerak.
 for(var i=0;i<al.length;i++){

  var p=al[i];

  // Formasi: begitu sudah sampai slotnya, TETAP menghadap musuh kalau ada target (biar bisa nyerang tanpa
  // bergerak/bongkar barisan); kalau tak ada musuh, baru menghadap arah radial formasi (globus) / arah slot.
  if(p.t==="p"&&p.form&&p.formAng!=null){
   var destX=p.gtx+p.ox,destY=p.gty+p.oy;
   if(ds(p,{x:destX,y:destY})<=SR*1.2){
    var tg=p.tgt?aT(p,p.tgt):p.formAng,df=nA(tg-p.a);p.a+=df*Math.min(1,3*dt);
    continue;
   }
  }

  var faceTarget=p.tgt?p.tgt:null;

  if(!faceTarget&&p.ord==="move"){var destX=p.gtx+p.ox,destY=p.gty+p.oy;if(ds(p,{x:destX,y:destY})>4)faceTarget={x:destX,y:destY}}

  if(faceTarget){var tg=aT(p,faceTarget),df=nA(tg-p.a);p.a+=df*Math.min(1,3*dt)}

 }



 for(var i=0;i<al.length;i++){var pq=al[i];if(pq.role==="inf"||pq.gen){pq.tgt=null;pq.zone=null;pq.orbiting=null}}
 for(var _sg=0;_sg<4;_sg++){var pgen=pgens[_sg];if(!(pgen&&pgen.al))continue; // SEMUA jenderal punya siaga
  // Mode SIAGA jendral: radius 1.5x jangkauan bidak (AR). Kalau ada musuh masuk radius ini, jendral
  // TIDAK ikut bertarung/mendekat, melainkan kabur ke BELAKANG kerumunan bidak sendiri (posisi menjauh
  // dari arah musuh) - urutan akhir jadi jendral-bidak-musuh. Kalau aman lagi, balik ke slot formasi
  // (baseGtx/baseGty, disetel sekali saat orderMove sesuai tombol "Jendral: kiri/bawah/kanan/atas/tengah").
  // Jendral "terlindungi penuh" (globus+tengah = sudah terkurung 360° oleh bidak sendiri di lubang tengah,
  // tak ada gunanya kabur - malah bikin keluar barisan) ATAU sedang menjalankan perintah GoTo (wajib patuh
  // lurus spt bidak biasa yg mode GoTo, tak boleh menyimpang dari lubang/posisi formasi krn ada musuh
  // lewat di dekatnya) - dlm 2 kondisi ini SIAGA kabur di-skip, jendral selalu balik ke slot formasinya.
  var protectedCenter=pgen.gotoOrder||(pgen.formSnap==="globus"&&pgen.genModeSnap==="tengah");
  var nd=1e9,threatE=null;
  for(var i=0;i<al.length;i++){var pe=al[i];if(pe.t==="e"){var d=ds(pe,pgen);if(d<nd){nd=d;threatE=pe}}}
  var standbyR=AR*1.5;
  if(!protectedCenter&&threatE&&nd<standbyR){
   var sx=0,sy=0,sn=0;
   for(var i=0;i<al.length;i++){var pe=al[i];if(pe.t==="p"&&!pe.gen&&ds(pe,pgen)<600){sx+=pe.x;sy+=pe.y;sn++}}
   if(sn){
    var cx=sx/sn,cy=sy/sn,dxh=cx-threatE.x,dyh=cy-threatE.y,dlh=Math.sqrt(dxh*dxh+dyh*dyh)||1;
    pgen.obey=true;pgen.ord="move";pgen.form=null;pgen.gid=0;pgen.ox=0;pgen.oy=0;
    pgen.gtx=cx+dxh/dlh*120;pgen.gty=cy+dyh/dlh*120;
   }
  }else if(pgen.baseGtx!=null){
   pgen.obey=true;pgen.ord="move";pgen.gtx=pgen.baseGtx;pgen.gty=pgen.baseGty;
  }
 }
 cmdTick(dt);zoneTick(dt,al);
 // === GERAK (satu loop, kecepatan sama utk semua) ===

 for(var i=0;i<al.length;i++){

  var p=al[i];

  var dx=0,dy=0,sp=MS*sM(p.x,p.y)*(p.runner?1.25:1);



  if(p.rt){

   // Mundur: geser mundur sambil tetap menghadap musuh (waspada). Speed sama persis dgn jalan biasa (sp = MS*sM, tak ada pengali lain).

   dx=-Math.cos(p.a)*sp;dy=-Math.sin(p.a)*sp;

   p.rt2-=dt;if(p.rt2<=0){p.rt=false;p.rtW=false}

  }else if(isAnchored(p)){

   // Berlabuh (formasi sudah di slot / GoTo sudah tiba tujuan): TIDAK bergerak sama sekali walau punya target -
   // cukup diam menghadap & menyerang (blok TEMPUR di bawah tetap menghitung damage berdasar jarak & arah hadap).
   dx=0;dy=0;

  }else if(p.tgt&&p.zone&&!p.gotoBlock){

   var tgt=p.tgt;

   if(p.orbiting){

    // Orbit: tuju sebuah titik di lingkaran radius ORB yang sedikit di depan posisi angular sekarang.

    // Ini otomatis menggabungkan koreksi radius (jika terlalu jauh/dekat) dengan gerak mengitari.

    var curA=aT(tgt,p);

    var curD=ds(p,tgt);

    // Besar langkah sudut disesuaikan: jika masih jauh dari radius, sudut kecil dulu (prioritas mendekat radius)

    var angStep=p.orbitDir*1.4*dt*Math.min(1,ORB/Math.max(curD,1));

    var seekA=curA+angStep;

    var seekPt={x:tgt.x+Math.cos(seekA)*ORB,y:tgt.y+Math.sin(seekA)*ORB};

    seekPt.x=Math.max(PR,Math.min(BW-PR,seekPt.x));seekPt.y=Math.max(PR,Math.min(BH-PR,seekPt.y));

    var a2=aT(p,seekPt);

    dx=Math.cos(a2)*sp;dy=Math.sin(a2)*sp;

   }else{

    // Mendekat sampai jarak SR (jangkauan pedang), TIDAK perlu body-to-body

    var d=ds(p,tgt);

    if(d>SR*0.85){

     var a2=aT(p,tgt);dx=Math.cos(a2)*sp;dy=Math.sin(a2)*sp;

    }

    // d<=SR*0.85: sudah dalam jangkauan pedang, berhenti - blok TEMPUR menangani hit

   }

  }else if(p.gotoBlock&&p.ord==="move"){

   // GoTo yg sedang menghantam musuh penghalang: TETAP jalan lurus ke tujuan asli (tak berhenti,

   // tak mendekat/mengejar musuh) - blok TEMPUR di bawah tetap menghitung damage berdasar p.tgt/zone

   // selama musuh itu kebetulan ada dlm jangkauan pedang & di depan, tanpa mengubah lintasan ini.

   var destX=p.gtx+p.ox,destY=p.gty+p.oy;

   var dd=ds(p,{x:destX,y:destY});

   if(dd>4){var a2=aT(p,{x:destX,y:destY});dx=Math.cos(a2)*sp;dy=Math.sin(a2)*sp}

  }else if((p.t==="p"||p.cmd)&&p.ord==="move"){

   var destX=p.gtx+p.ox,destY=p.gty+p.oy;

   var dd=ds(p,{x:destX,y:destY});

   if(dd>4){var a2=aT(p,{x:destX,y:destY});dx=Math.cos(a2)*sp;dy=Math.sin(a2)*sp}

   else{p.ord=null}

  }else if(p.t==="e"&&p.i>=0&&!p.cmd){

   var te=tr[p.i];var d2=ds(p,te);

   if(d2>te.r*0.65){var a2=aT(p,te);dx=Math.cos(a2)*sp*0.5;dy=Math.sin(a2)*sp*0.5}

  }



  p.x+=dx*dt;p.y+=dy*dt;

  p.x=Math.max(PR,Math.min(BW-PR,p.x));p.y=Math.max(PR,Math.min(BH-PR,p.y));

 }



 // === COLLISION: SELALU aktif, dorong keluar overlap murni (radius bidak). Grid rapat (CCELL) + vektor langsung (tanpa atan2/cos/sin) biar cepat di kerumunan besar. ===

 var cGrid=buildGrid(al,CCELL);

 var cCand=[];

 var COLR2=COLR*COLR;

 for(var i=0;i<al.length;i++){

  var p=al[i];

  queryGrid(cGrid,CCELL,p.x,p.y,COLR,cCand);

  for(var k=0;k<cCand.length;k++){

   var j=cCand[k];if(j<=i)continue;

   var o=al[j];

   var vx=p.x-o.x,vy=p.y-o.y;

   var d2=vx*vx+vy*vy;

   if(d2>=COLR2||d2<0.0001)continue;

   var d=Math.sqrt(d2);

   var overlap=COLR-d;

   var ux=vx/d,uy=vy/d; // vektor satuan arah o->p (menggantikan atan2+cos+sin)

   var tx=(i%2===0)?-uy:uy,ty=(i%2===0)?ux:-ux; // tegak lurus, utk wobble

   var wobble=overlap*0.12;

   var pushX=ux*overlap*0.5+tx*wobble,pushY=uy*overlap*0.5+ty*wobble;

   p.x+=pushX;p.y+=pushY;o.x-=pushX;o.y-=pushY;

   p.x=Math.max(PR,Math.min(BW-PR,p.x));p.y=Math.max(PR,Math.min(BH-PR,p.y));

   o.x=Math.max(PR,Math.min(BW-PR,o.x));o.y=Math.max(PR,Math.min(BH-PR,o.y));

  }

 }



 // === TRIGGER MUNDUR DINI: dgn radius RSR (sedikit lebih lebar dr SR, di ujung jangkauan pedang), 2+ penyerang zona depan yg terdeteksi disini memicu mundur SEBELUM benar2 masuk radius damage penuh SR - memberi ruang agar target sempat kabur tanpa kena hit. Pakai groupsByTgt (sudah dihitung di ASSIGN ZONA) drpd scan semua bidak. ===

 for(var i=0;i<al.length;i++){

  var tgt=al[i];if(!tgt.al||tgt.rt)continue;

  var atkers=groupsByTgt.get(tgt);if(!atkers)continue;

  var frontN=0;

  for(var k=0;k<atkers.length;k++){

   var p=atkers[k];if(p.rt||!p.zone||p.orbiting)continue;

   if(!isFrontZone(p.zone))continue;

   if(ds(p,tgt)>RSR)continue;

   if(!iF(p,tgt))continue;

   frontN++;

  }

  if(frontN>=2){tgt.rt=true;tgt.rt2=0.6;tgt.tgt=null;tgt.zone=null}

 }



 // === TEMPUR: "pedang" - jarak SR & harus ada di depan penyerang (iF), zona ASSIGNED (p.zone) menentukan front/back ===

 var dmgMap=new Map(); // target -> {front:[atkers], back:[atkers]}

 for(var i=0;i<al.length;i++){

  var p=al[i];if(!p.al||p.gen||p.rt||!p.tgt||!p.zone||p.orbiting)continue;

  var tgt=p.tgt;

  var d=ds(p,tgt);

  if(d>SR)continue;

  if(!iF(p,tgt))continue; // musuh harus berada di depan penyerang (jangkauan pedang berbentuk kerucut depan)

  if(!dmgMap.has(tgt))dmgMap.set(tgt,{front:[],back:[]});

  var entry=dmgMap.get(tgt);

  if(isFrontZone(p.zone))entry.front.push(p);else entry.back.push(p);

 }

 dmgMap.forEach(function(entry,tgt){

  if(tgt.rt)return; // sedang mundur, immune dari damage & tidak bisa di-trigger retreat lagi

  tgt.eng=true;

  if(entry.front.length>0&&entry.back.length>0&&!tgt.gen){
   // Kena dari depan DAN belakang sekaligus = mati instan

   tgt.hp=0;tgt.al=false;sP(tgt.x,tgt.y,"d");shk=6;

   return;

  }

  if(entry.front.length>=2&&!tgt.gen){
   // 2+ penyerang depan sekaligus = target mundur (jalan biasa, bukan dorongan)

   tgt.rt=true;tgt.rt2=0.6;tgt.tgt=null;tgt.zone=null;

   return;

  }

  // Damage: tiap penyerang yg berhasil kena (depan atau belakang, tanpa kombinasi mati instan) memberi damage penuh

  var atkers=entry.front.concat(entry.back);

  tgt.hp-=DR*dt*atkers.length*(tgt.gen?((entry.front.length>0&&entry.back.length>0)?1.2:0.6):1);

  tgt.hf=0.12;

  if(tgt.hp<=0){tgt.al=false;sP(tgt.x,tgt.y,"d");shk=4}

 });



 // === KOORDINASI FLANK: 2 bidak depan (FL/FR) SELALU nyerang duluan spt biasa. Begitu musuh ybs kepicu mundur
 // (tgt.rt=true, krn tekanan 2 depan di blok TRIGGER MUNDUR DINI / TEMPUR di atas) DAN si grup masih punya flanker
 // (zona BL/BR) yg BELUM tuntas orbit (orbiting=true, msh di kuadran depan musuh), maka 2 bidak depan itu MULAI
 // mundur & TERUS ditahan mundur (p.holdBack) selama flanker masih belum tuntas - TIDAK dilepas begitu saja saat
 // tgt.rt musuh habis/expired, supaya mereka tak langsung maju lagi sebelum flanker beres. Begitu flanker sudah
 // sukses masuk zona belakang (orbiting=false / terkunci), holdBack dilepas seketika & bidak depan langsung
 // lanjut menyerang normal lagi.
 for(var i=0;i<al.length;i++){

  var tgt=al[i];if(!tgt.al)continue;

  var atkers=groupsByTgt.get(tgt);if(!atkers)continue;

  var flankerBelumTuntas=false;

  for(var k=0;k<atkers.length;k++){

   var f=atkers[k];if(isBackZone(f.zone)&&f.orbiting){flankerBelumTuntas=true;break}

  }

  for(var k=0;k<atkers.length;k++){

   var p=atkers[k];if(!isFrontZone(p.zone))continue;

   if(p.obey){p.holdBack=false;continue} // GoTo: jalan mutlak ke tujuan, tak boleh ditahan mundur gara2 strategi tunggu-flanker

   if(flankerBelumTuntas&&(p.holdBack||tgt.rt)){

    p.holdBack=true;p.rt=true;p.rt2=Math.max(p.rt2||0,0.2);

   }else if(!flankerBelumTuntas&&p.holdBack){

    p.holdBack=false;p.rt=false;

   }

  }

 }



 // Hit flash decay

 for(var i=0;i<al.length;i++)if(al[i].hf>0)al[i].hf-=dt;



 // Partikel

 for(var i=pt.length-1;i>=0;i--){var p=pt[i];p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=0.94;p.vy*=0.94;p.lf-=dt;if(p.lf<=0)pt.splice(i,1)}



 // Wilayah
 // OPTIMASI: pengecekan taklukan wilayah ini mahal (tiap wilayah x tiap bidak x titik-dlm-poligon
 // dgn puluhan vertex), jadi tak perlu dihitung tiap frame (60x/detik) - cukup beberapa kali per
 // detik saja, tak terasa bedanya secara gameplay tapi jauh lebih ringan di CPU.
 wilTimer+=dt;
 if(wilTimer>=0.25){
  wilTimer=0;

  for(var t=0;t<tr.length;t++){

   var te=tr[t];if(te.tm==="p")continue;

   var eI=0,pI=0;

   for(var i=0;i<al.length;i++){if(pip(te.poly,al[i].x,al[i].y)){if(al[i].t==="e"&&al[i].i===t)eI++;else if(al[i].t==="p")pI++}}

   // === FOG OF WAR PER-WILAYAH ===
   // Musuh di wilayah ini cuma "aktif" (terlihat & ikut simulasi) selama minimal 1 bidak pemain
   // sedang BERADA di dalam poligon wilayah tsb. Begitu bidak terakhir keluar, semua musuh di
   // wilayah itu disembunyikan lagi (bukan dihapus - hp/posisi tetap tersimpan apa adanya,
   // jadi kalau diintai ulang nanti sisa pasukannya masih sama seperti terakhir ditinggal).
   var justRevealed=false;

   if(pI>0&&!te.revealed){

    te.revealed=true;justRevealed=true;

    for(var qi=0;qi<pc.length;qi++){var q=pc[qi];if(q.t==="e"&&q.i===t&&q.al)q.hidden=false}

   }else if(pI===0&&te.revealed&&te.st!=="lead"){

    te.revealed=false;

    for(var qi=0;qi<pc.length;qi++){var q=pc[qi];if(q.t==="e"&&q.i===t&&q.al)q.hidden=true}

   }

   // eI dihitung dari `al` yg belum memasukkan musuh yg BARU SAJA di-reveal tick ini (baru masuk
   // tick berikutnya) - jadi capture check ditunda 1 tick (~0.25dtk) kalau baru saja reveal,
   // supaya tidak salah anggap wilayah kosong padahal garnisunnya baru saja tersingkap.
   if(!justRevealed&&eI===0&&pI>0&&!(te.gp&&te.gp.al)&&!(te.gp2&&te.gp2.al)){te.tm="p";mcDirty=true;tK('Wilayah "'+te.nm+'" ditaklukkan!')}

  }
 }



 // === JENDERAL: cegah mundur, konversi pasukan saat jenderal wilayah gugur ===
 for(var _wo=0;_wo<4;_wo++){
  var wg=pgens[_wo];if(!wg)continue;
  wg.rt=false;
  if(wg.hp<wg.mhp*0.4&&!wg.warn&&wg.al){wg.warn=true;__warnQ.push(_wo)}
  else if(wg.hp>wg.mhp*0.6)wg.warn=false;
 }
 for(var t=0;t<tr.length;t++){
  var te=tr[t];if(!te.gp&&!te.gp2)continue;
  if(te.gp)te.gp.rt=false;if(te.gp2)te.gp2.rt=false;
  if(!(te.gp&&te.gp.al)&&!(te.gp2&&te.gp2.al)&&!te.conv){
   te.conv=true;var nc=0;
   // round-robin: bidak yg beralih dibagi RATA hanya ke owner yg AKTIF (slot terisi) - owner
   // kosong (mis. cuma main bertiga) dilewati, supaya tidak ada bidak "hilang" ke slot kosong.
   var activeOwners=[];for(var oi=0;oi<4;oi++)if(mpPlayers[oi])activeOwners.push(oi);
   var rrIdx=0;
   for(var qi=0;qi<pc.length;qi++){
    var q=pc[qi];
    if(q.t==="e"&&q.i===t&&q.al){q.t="p";q.i=-1;q.owner=activeOwners[rrIdx%activeOwners.length];rrIdx++;q.hidden=false;q.tgt=null;q.zone=null;q.ord=null;q.obey=false;q.form=null;q.gid=0;q.rt=false;q.holdBack=false;q.orbiting=null;q.cmd=false;q.role="atk";q.runner=false;q.hf=0.4;nc++}
   }
   for(var qi=0;qi<pc.length;qi++){var q=pc[qi];if(q.tgt&&q.tgt.t===q.t){q.tgt=null;q.zone=null;q.orbiting=null}}
   tK('Jenderal '+te.rl+' dari '+te.nm+' gugur! '+nc+' pasukan dibagi rata ke semua jenderal');
  }
 }
 // Hitung
 var pa=0,ea=0;

 for(var i=0;i<al.length;i++){if(al[i].t==="p")pa++;else ea++}

 document.getElementById("pC").textContent=pa;

 document.getElementById("eC").textContent=ea; // HUD sengaja cuma tampilkan musuh yg sudah keliatan (fog of war)

 var cp=0;for(var t=0;t<tr.length;t++)if(tr[t].tm==="p")cp++;

 document.getElementById("tC").textContent=cp+"/20";

 // PENTING: cek menang/kalah HARUS pakai jumlah musuh TOTAL yg masih hidup (termasuk yg masih
 // hidden/blm diintai lewat fog of war), BUKAN cuma `ea` yg sudah difilter hidden di atas.
 // Kalau pakai `ea`, di awal game semua musuh msh hidden => ea=0 => dikira "menang" padahal
 // musuhnya masih ada, cuma belum diintai - ini yg bikin game langsung freeze di awal.
 var eaTotal=0;for(var i=0;i<pc.length;i++)if(pc[i].al&&pc[i].t==="e")eaTotal++;

 // ====== RESPAWN PER-OWNER (ala MOBA) ======
 // Owner kalah (jendral tumbang) mulai timer respawn; kalau timer habis, 25 bidak+jendral direset
 // total di markas owner itu. Kekalahan TOTAL cuma terjadi kalau ke-4 owner mati BERSAMAAN
 // (tak ada satupun yg masih hidup utk "menunggu" respawn owner lain).
 var nowMs=performance.now();
 for(var oi=0;oi<4;oi++){
  var og=pgens[oi];
  if(!og)continue;
  var ownerAlive=og.al; // owner dianggap kalah saat JENDERAL-nya tumbang (sisa bidak ikut hangus saat respawn)
  if(!ownerAlive){
   if(mpRespawnTimers[oi]===0){
    mpRespawnTimers[oi]=nowMs+mpRespawnDelaySec()*1000;
    __deathQ.push(oi); // server kirim pesan ini hanya ke pemilik jenderal
   } else if(nowMs>=mpRespawnTimers[oi]){
    mpRespawnOwner(oi);
    mpRespawnTimers[oi]=0;
   }
  } else if(mpRespawnTimers[oi]!==0){
   mpRespawnTimers[oi]=0; // owner ternyata masih ada bidak hidup (jarang, tp jaga2), batalkan timer
  }
 }

 var anyOwnerAlive=false;
 for(var oi=0;oi<4;oi++){
  if(pgens[oi]&&pgens[oi].al){anyOwnerAlive=true;break}
 }

 if(!anyOwnerAlive&&!go){go=true;tK("KEKALAHAN TOTAL! Semua jenderal gugur bersamaan")}

 else if(eaTotal===0&&!go){go=true;tK("KEMENANGAN!")}

}



// RENDER

function render(){

 cx.clearRect(0,0,cv.width,cv.height);

 // Latar peta (gambar acuan asli, digambar sesuai transformasi kamera)
 if(bgReady){
  var bp0=b2s(0,0),bp1=b2s(BW,BH);
  cx.drawImage(bgImg,bp0.x,bp0.y,bp1.x-bp0.x,bp1.y-bp0.y);
 }else{
  cx.fillStyle="#8a9a5c";cx.fillRect(0,0,cv.width,cv.height);
 }

 // Label laut (nama tempel di atas perairan, bukan wilayah yg bisa ditaklukkan)
 cx.textAlign="center";cx.fillStyle="rgba(235,246,252,.85)";cx.strokeStyle="rgba(8,20,30,.75)";
 for(var sl=0;sl<seaLabels.length;sl++){
  var seaL=seaLabels[sl],sp=b2s(seaL.x,seaL.y);
  if(sp.x<-100||sp.x>cv.width+100||sp.y<-20||sp.y>cv.height+20)continue;
  var fsz=Math.max(10.5,15*seaL.sz*cam.z);
  cx.font="italic bold "+fsz+"px monospace";
  cx.lineWidth=Math.max(1.1,3.2*cam.z);
  cx.strokeText(seaL.nm,sp.x,sp.y);
  cx.fillText(seaL.nm,sp.x,sp.y);
 }
 cx.textAlign="center";



 // Penghalang tepi map (batu coklat kehitaman) - digambar DI LUAR batas dunia (0..BW,0..BH), bukan menjorok ke dalam

 var bTop=b2s(0,-BORDER),bTopE=b2s(BW,0);

 var gTop=cx.createLinearGradient(0,bTop.y,0,bTopE.y);

 gTop.addColorStop(0,"#171310");gTop.addColorStop(1,"#4a3624");

 cx.fillStyle=gTop;cx.fillRect(bTop.x,bTop.y,bTopE.x-bTop.x,bTopE.y-bTop.y);



 var bBotS=b2s(0,BH),bBotE=b2s(BW,BH+BORDER);

 var gBot=cx.createLinearGradient(0,bBotE.y,0,bBotS.y);

 gBot.addColorStop(0,"#171310");gBot.addColorStop(1,"#4a3624");

 cx.fillStyle=gBot;cx.fillRect(bBotS.x,bBotS.y,bBotE.x-bBotS.x,bBotE.y-bBotS.y);



 var bLeftS=b2s(-BORDER,0),bLeftE=b2s(0,BH);

 var gLeft=cx.createLinearGradient(bLeftS.x,0,bLeftE.x,0);

 gLeft.addColorStop(0,"#171310");gLeft.addColorStop(1,"#4a3624");

 cx.fillStyle=gLeft;cx.fillRect(bLeftS.x,bLeftS.y,bLeftE.x-bLeftS.x,bLeftE.y-bLeftS.y);



 var bRightS=b2s(BW,0),bRightE=b2s(BW+BORDER,BH);

 var gRight=cx.createLinearGradient(bRightE.x,0,bRightS.x,0);

 gRight.addColorStop(0,"#171310");gRight.addColorStop(1,"#4a3624");

 cx.fillStyle=gRight;cx.fillRect(bRightS.x,bRightS.y,bRightE.x-bRightS.x,bRightE.y-bRightS.y);



 // Tekstur bongkahan batu

 for(var i=0;i<rocks.length;i++){

  var rk=rocks[i],rp=b2s(rk.x,rk.y),rr=rk.r*cam.z;

  if(rp.x<-40||rp.x>cv.width+40||rp.y<-40||rp.y>cv.height+40)continue;

  var shade=26+Math.floor(rk.sh*36);

  cx.beginPath();cx.arc(rp.x,rp.y,rr,0,Math.PI*2);

  cx.fillStyle="rgb("+shade+","+Math.floor(shade*0.78)+","+Math.floor(shade*0.58)+")";

  cx.fill();

  cx.strokeStyle="rgba(0,0,0,.35)";cx.lineWidth=Math.max(0.6,1*cam.z);cx.stroke();

 }



 // Wilayah (poligon sesuai batas garis pada peta acuan asli)
 // OPTIMASI: lewati (skip) wilayah yg bounding box-nya di luar layar sepenuhnya - ini paling mahal
 // krn tiap wilayah punya puluhan titik poligon + strokeText nama (strokeText itu sendiri berat).
 for(var t=0;t<tr.length;t++){

  var te=tr[t];

  if(te.bb){
   var bc0=b2s(te.bb.minX,te.bb.minY),bc1=b2s(te.bb.maxX,te.bb.maxY);
   var bxL=Math.min(bc0.x,bc1.x)-30,bxR=Math.max(bc0.x,bc1.x)+30,byT=Math.min(bc0.y,bc1.y)-30,byB=Math.max(bc0.y,bc1.y)+30;
   if(bxR<0||bxL>cv.width||byB<0||byT>cv.height)continue;
  }

  cx.beginPath();

  for(var vi=0;vi<te.poly.length;vi++){

   var vp=b2s(te.poly[vi][0],te.poly[vi][1]);

   if(vi===0)cx.moveTo(vp.x,vp.y);else cx.lineTo(vp.x,vp.y);

  }

  cx.closePath();

  cx.fillStyle=te.tm==="p"?"rgba(74,154,74,.22)":te.cl;cx.fill();

  cx.setLineDash([6*cam.z,4*cam.z]);

  cx.strokeStyle=te.tm==="p"?"#4a9a4a":te.bc;

  cx.lineWidth=Math.max(1,1.5*cam.z);cx.stroke();cx.setLineDash([]);

  var c=b2s(te.cx,te.cy),r=te.r*cam.z;

  cx.fillStyle=te.tm==="p"?"#bfe6bf":"#fff7d8";

  cx.strokeStyle="rgba(0,0,0,.85)";cx.lineWidth=Math.max(0.9,3.6*cam.z);

  cx.font="bold "+Math.max(10.5,16.5*cam.z)+"px monospace";cx.textAlign="center";

  cx.strokeText(te.nm,c.x,c.y);

  cx.fillText(te.nm,c.x,c.y);

  if(te.tm==="p"){var tkY=c.y+Math.max(15,19*cam.z);cx.fillStyle="#bfe6bf";cx.strokeText("[TAKLUK]",c.x,tkY);cx.fillText("[TAKLUK]",c.x,tkY)}

 }



 // Bidak (sort by y)

 var sd=[];for(var i=0;i<pc.length;i++)if(pc[i].al&&!pc[i].hidden)sd.push(i);

 sd.sort(function(a,b){return pc[a].y-pc[b].y});



 if(hz){cx.save();
  var tnow=performance.now()/1000;
  for(var zi=0;zi<hz.length;zi++){
   var z=hz[zi],zc0=b2s(z.x,z.y);
   var pts=[];for(var pk=0;pk<z.poly.length;pk++){var wp=z.poly[pk];pts.push(b2s(wp.x,wp.y))}
   if(z.t==="api"){
    // Api: lidah api "berkobar" - poligon berdenyut (skala tiap titik berosilasi beda fase)
    // + gradient radial warna kuning->jingga->merah yg juga berdenyut, jadi kesannya terbakar.
    var flick=0.78+0.22*Math.sin(tnow*6+zi*1.7);
    var apts=pts.map(function(p,pi){var dx=p.x-zc0.x,dy=p.y-zc0.y,s=0.88+0.16*Math.sin(tnow*7+pi*1.3+zi*2.1);return{x:zc0.x+dx*s,y:zc0.y+dy*s}});
    drawBlob(cx,apts);
    var rg=cx.createRadialGradient(zc0.x,zc0.y,0,zc0.x,zc0.y,Math.max(4,z.r*cam.z*1.15));
    rg.addColorStop(0,"rgba(255,230,140,"+(0.6*flick).toFixed(2)+")");
    rg.addColorStop(0.55,"rgba(255,110,25,"+(0.5*flick).toFixed(2)+")");
    rg.addColorStop(1,"rgba(170,30,10,0.12)");
    cx.fillStyle=rg;cx.fill();
    cx.strokeStyle="rgba(255,160,60,"+(0.65*flick).toFixed(2)+")";cx.lineWidth=Math.max(1,1.4*cam.z);cx.stroke();
   }else{
    drawBlob(cx,pts);
    cx.fillStyle=ZC[z.t];cx.fill();
    cx.setLineDash([6,4]);cx.strokeStyle=ZS[z.t];cx.lineWidth=1.5;cx.stroke();cx.setLineDash([]);
   }
  }
  cx.restore();}
 for(var si=0;si<sd.length;si++){

  var idx=sd[si],p=pc[idx],s=b2s(p.x,p.y),r=PR*cam.z*(p.gen?2.2:1);
  if(s.x<-20||s.x>cv.width+20||s.y<-20||s.y>cv.height+20)continue;
  // Fog of war KOOPERATIF: gabungan jarak pandang dari SEMUA jendral tim yg masih hidup (bukan cuma
  // jendral lokal), supaya tiap pemain bisa lihat area yg sudah dijelajah rekan setimnya juga.
  var anyGenSees=false;
  for(var _gi=0;_gi<4;_gi++){var _g=pgens[_gi];if(_g&&_g.al){var gdx=p.x-_g.x,gdy=p.y-_g.y;if(gdx*gdx+gdy*gdy<=GEN_SIGHT*GEN_SIGHT){anyGenSees=true;break}}}
  if(!anyGenSees&&p!==pgen)continue;

  var isP=p.t==="p",ppA=p.a+Math.PI/2,isMyGen=isP&&p.gen&&p.owner===mpMyOwner; // isMyGen = jendral pemain LOKAL (pakai foto profil sendiri)
  var isOtherGen=isP&&p.gen&&p.owner!==mpMyOwner; // jendral rekan setim lain (pakai foto profil masing2, tanpa nama besar)
  var ownerColor=OWNER_COLORS[p.owner]||"#d4a832";



  // Bayangan

  cx.beginPath();cx.arc(s.x+1.5*cam.z,s.y+1.5*cam.z,r,0,Math.PI*2);cx.fillStyle="rgba(0,0,0,.25)";cx.fill();



  if(isMyGen||isOtherGen){
   // Jendral (pemain lokal ATAU rekan setim): badan = foto profil bulat (statis, tak ikut berputar).
   cx.save();cx.beginPath();cx.arc(s.x,s.y,r,0,Math.PI*2);cx.closePath();cx.clip();
   var gImg=isMyGen?playerPhotoImg:mpPhotoImgs[p.owner];
   if(gImg){
    var iw=gImg.width,ih=gImg.height,cov=Math.max((r*2)/iw,(r*2)/ih),dw=iw*cov,dh=ih*cov;
    cx.drawImage(gImg,s.x-dw/2,s.y-dh/2,dw,dh);
   }else{cx.fillStyle=ownerColor;cx.fillRect(s.x-r,s.y-r,r*2,r*2);}
   cx.restore();
   cx.beginPath();cx.arc(s.x,s.y,r,0,Math.PI*2);cx.strokeStyle=ownerColor;cx.lineWidth=Math.max(1.5,2*cam.z);cx.stroke();
  }else{

  // Setengah belakang

  cx.beginPath();cx.moveTo(s.x,s.y);cx.arc(s.x,s.y,r,p.a+Math.PI/2,p.a+3*Math.PI/2);cx.closePath();

  cx.fillStyle=isP?"#7a5a10":"#6a1a1a";cx.fill();



  // Setengah depan

  cx.beginPath();cx.moveTo(s.x,s.y);cx.arc(s.x,s.y,r,p.a-Math.PI/2,p.a+Math.PI/2);cx.closePath();

  cx.fillStyle=p.hf>0?"#fff":(isP?ownerColor:"#c44040");cx.fill();



  // Garis pemisah depan/belakang

  cx.beginPath();

  cx.moveTo(s.x+Math.cos(ppA)*r,s.y+Math.sin(ppA)*r);

  cx.lineTo(s.x-Math.cos(ppA)*r,s.y-Math.sin(ppA)*r);

  cx.strokeStyle="rgba(255,255,255,.4)";cx.lineWidth=Math.max(0.8,1.2*cam.z);cx.stroke();

  }



  // Panah arah

  var aD=r+4*cam.z,aS=3.5*cam.z,ax=s.x+Math.cos(p.a)*aD,ay=s.y+Math.sin(p.a)*aD;

  cx.beginPath();

  cx.moveTo(ax+Math.cos(p.a)*aS,ay+Math.sin(p.a)*aS);

  cx.lineTo(ax+Math.cos(p.a+2.4)*aS,ay+Math.sin(p.a+2.4)*aS);

  cx.lineTo(ax+Math.cos(p.a-2.4)*aS,ay+Math.sin(p.a-2.4)*aS);

  cx.closePath();cx.fillStyle=isP?ownerColor:"#ff6666";cx.fill();



  if(p.gen){cx.beginPath();cx.arc(s.x,s.y,r*1.2,0,Math.PI*2);cx.strokeStyle=isP?ownerColor:"#ffb0b0";cx.lineWidth=Math.max(1.5,2.5*cam.z);cx.stroke()}
  // Seleksi
  cx.beginPath();cx.arc(s.x,s.y,r,0,Math.PI*2);

  if(sel.has(idx)){

   cx.strokeStyle="#ffe066";cx.lineWidth=Math.max(1,2*cam.z);cx.stroke();

   cx.beginPath();cx.arc(s.x,s.y,r+3*cam.z,0,Math.PI*2);

   cx.strokeStyle="rgba(255,224,102,.35)";cx.lineWidth=Math.max(0.8,1.2*cam.z);

   cx.setLineDash([3*cam.z,2*cam.z]);cx.stroke();cx.setLineDash([]);

  }else{cx.strokeStyle="rgba(0,0,0,.35)";cx.lineWidth=0.8;cx.stroke()}



  // Indikator perintah

  if(isP&&(p.ord||p.tgt||p.rt)){

   var icol=p.obey?"#4488ff":(p.tgt?(p.orbiting?"#ffaa33":"#ff5533"):(p.rt?"#e08a2a":"#4a9a4a"));

   var ix=s.x,iy=s.y-r-14*cam.z;

   cx.beginPath();cx.arc(ix,iy,Math.max(1.5,2.5*cam.z),0,Math.PI*2);cx.fillStyle=icol;cx.fill();

  }



  // Bar HP

  var mh=p.mhp||100;
  if((p.hp<mh||p.gen)&&p.hp>0){

   var bw=r*1.5,bh=Math.max(1.5,2.5*cam.z),bx=s.x-bw/2,by=s.y-r-6*cam.z;

   cx.fillStyle="rgba(0,0,0,.5)";cx.fillRect(bx,by,bw,bh);

   cx.fillStyle=p.hp>mh*0.5?"#4a9a4a":p.hp>mh*0.25?"#9a9a2a":"#9a2a2a";
   cx.fillRect(bx,by,bw*(p.hp/mh),bh);

  }



  // Nama pemain di atas badan jendral (putih, border hitam) - utk SEMUA jendral (diri sendiri & rekan setim)
  if(isMyGen||isOtherGen){
   var gName=isMyGen?playerName:((mpPlayers[p.owner]&&mpPlayers[p.owner].name)||OWNER_NAMES[p.owner]);
   cx.font="bold "+Math.max(9,12*cam.z)+"px monospace";
   cx.textAlign="center";cx.textBaseline="alphabetic";
   var nmY=s.y-r-20*cam.z;
   cx.lineWidth=Math.max(2,3*cam.z);cx.strokeStyle="#000";cx.strokeText(gName,s.x,nmY);
   cx.fillStyle="#fff";cx.fillText(gName,s.x,nmY);
  }

  // Nama jendral musuh (penguasa wilayah) di atas badannya - sama gayanya spt nama player
  if(!isP&&p.gen&&tr[p.i]&&tr[p.i].rl){
   cx.font="bold "+Math.max(9,12*cam.z)+"px monospace";
   cx.textAlign="center";cx.textBaseline="alphabetic";
   var enmY=s.y-r-20*cam.z;
   cx.lineWidth=Math.max(2,3*cam.z);cx.strokeStyle="#000";cx.strokeText(tr[p.i].rl,s.x,enmY);
   cx.fillStyle="#fff";cx.fillText(tr[p.i].rl,s.x,enmY);
  }

 }



 // Drag seleksi box

 if(drag){

  var d1=b2s(drag.x0,drag.y0),d2=b2s(drag.x1,drag.y1);

  var lx=Math.min(d1.x,d2.x),ly=Math.min(d1.y,d2.y),rw=Math.abs(d2.x-d1.x),rh=Math.abs(d2.y-d1.y);

  cx.strokeStyle="#d4a832";cx.lineWidth=1;cx.setLineDash([5,3]);cx.strokeRect(lx,ly,rw,rh);cx.setLineDash([]);

  cx.fillStyle="rgba(212,168,50,.06)";cx.fillRect(lx,ly,rw,rh);

 }



 // Partikel

 for(var i=0;i<pt.length;i++){

  var p=pt[i],ps=b2s(p.x,p.y);

  cx.globalAlpha=Math.max(0,p.lf/p.ml);

  cx.beginPath();cx.arc(ps.x,ps.y,Math.max(1,p.sz*cam.z),0,Math.PI*2);

  cx.fillStyle=p.cl;cx.fill();

 }

 cx.globalAlpha=1;



 // MINIMAP
 // OPTIMASI: lapisan latar+poligon wilayah (mCache) cuma digambar ulang saat ADA PERUBAHAN
 // (wilayah baru ditaklukkan / gambar peta baru siap), bukan tiap frame - krn poligonnya
 // banyak titik & jarang berubah. Tiap frame cukup tempel cache itu + gambar titik bidak di atasnya.
 var mw=90,mh=56;
 var sx=mw/BW,sy=mh/BH;

 if(mcDirty)drawMinimapBase(sx,sy);

 mx.clearRect(0,0,mw,mh);
 mx.drawImage(mCache,0,0);

 for(var i=0;i<pc.length;i++){

  var p=pc[i];if(!p.al||p.hidden)continue;

  mx.fillStyle=p.t==="p"?(OWNER_COLORS[p.owner]||"#d4a832"):"#c44040";

  if(p.gen){mx.fillStyle="#fff";mx.fillRect(p.x*sx-1.5,p.y*sy-1.5,3,3)}else mx.fillRect(p.x*sx-0.5,p.y*sy-0.5,1.5,1.5);

 }

 var vx=(cam.x-cv.width/2/cam.z)*sx,vy=(cam.y-cv.height/2/cam.z)*sy;

 var vw=cv.width/cam.z*sx,vh=cv.height/cam.z*sy;

 mx.strokeStyle="#d4a832";mx.lineWidth=0.8;mx.strokeRect(vx,vy,vw,vh);

}



// GAME LOOP

function gl(t){

 if(mpEnded){requestAnimationFrame(gl);return}

 var dt=Math.min((t-lt)/1000,0.05);

 lt=t;

 if(mpIsHost){
  update(dt);
  mpTickBroadcast(t);
 } else {
  // Client: TIDAK menjalankan simulasi sendiri (physics/AI/combat host yg pegang kendali penuh),
  // supaya tak pernah desync. Cuma proses input lokal (drag-select dsb tetap jalan di sisi client
  // krn itu cuma UI, bukan simulasi) & render state yg terakhir diterima dari host.
 }

 render();

 requestAnimationFrame(gl);

}



function mpEnterGame(){
 mpGameStartTime=performance.now();
 iTr();
 iRocks();
 iPc();
 lt=performance.now();

 var endOv=document.createElement("div");
 endOv.id="mpEndOv";
 endOv.className="hd";
 endOv.style.cssText="position:fixed;inset:0;background:rgba(10,12,6,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:80;gap:14px";
 endOv.innerHTML='<h1 id="mpEndMsg" style="color:#c44040;font-size:18px;text-align:center;padding:0 20px">PERANG BERAKHIR</h1><button class="bt" onclick="location.reload()" style="padding:10px 20px">Main Lagi</button>';
 document.body.appendChild(endOv);
 var style=document.createElement("style");
 style.textContent="#mpEndOv.hd{display:none !important}";
 document.head.appendChild(style);

 requestAnimationFrame(gl);
}

// Loop TIDAK dimulai otomatis saat load - menunggu mpEnterGame() dipanggil setelah lobby (host mulai
// / client terima pesan "start"). Ini penting krn spawn (iPc dll) butuh mpMyOwner & mpPlayers terisi dulu.



function __zonesForClient(){
 if(!hz){try{genZones()}catch(e){hz=[]}}
 return hz.map(function(z){return {t:z.t,x:Math.round(z.x),y:Math.round(z.y),r:Math.round(z.r),poly:z.poly.map(function(q){return [Math.round(q.x),Math.round(q.y)]})}});
}
