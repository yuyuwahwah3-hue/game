

// KONFIG

var BW=16800,BH=9108,PR=9,SR=34,ORB=82.5,AR=180,MS=50,DR=26,FH=Math.PI*0.42;
var BORDER=390; // ketebalan penghalang batu di tepi map (dlm unit dunia)
var GEN_SIGHT=1000; // jarak pandang jendral pemain (unit dunia) - bidak/musuh yg lebih jauh dari ini
// dari jendral TIDAK DIGAMBAR (tak terlihat di layar, termasu musuh yg sedang dilawan), tapi simulasi
// (gerak/perang/spawn musuh) tetap jalan normal spt biasa - pertempuran terjadi "di belakang layar"
// tanpa sepengetahuan jendral. Bidak yg tersembunyi ini tetap bisa dipilih (drag-select pakai koordinat
// dunia, tak peduli tergambar atau tidak) & tetap bisa diperintah gerak spt biasa.
var playerName="Jenderal",playerPhotoImg=null,playerPhotoDataURL=null; // nama & foto profil jendral pemain, diisi dari halaman awal (#ov)

// ====== MULTIPLAYER (server dedicated via WebSocket, TIM vs TIM) ======
// Server (Railway) menjalankan SELURUH simulasi. Client hanya: kirim input, terima snapshot,
// interpolasi supaya gerak halus, lalu render() asli.
// 8 slot: 0-3 = tim HIJAU "A" (markas Hutan Sancang), 4-7 = tim MERAH "B" (markas Giri Kancana).
var OWNER_COLORS=["#6fcf6f","#3fae3f","#2a8a2a","#1a6b1a","#e06a6a","#c43c3c","#9c2222","#6e1414"]; // 4 corak hijau (A) + 4 corak merah (B)
var OWNER_NAMES=["Hijau 1","Hijau 2","Hijau 3","Hijau 4","Merah 1","Merah 2","Merah 3","Merah 4"];
var OWNER_TEAM=["A","A","A","A","B","B","B","B"];
var mpIsHost=false,mpMyOwner=0,mpMyTeam="A",mpGameStarted=false,mpEnded=false;
var mpWs=null,mpPlayers=new Array(8).fill(null),mpPhotoImgs=new Array(8).fill(null);
var pgens=new Array(8).fill(null); // referensi jenderal tiap owner (diisi dari snapshot)
var mpRespawnLeft=new Array(8).fill(0),mpGameMin=0;
var mpMode="pvp",mpTeamSize=4; // diisi dari pilihan lobi: "pvp"|"ai", ukuran tim 1-4
var mpSnapCur=null,mpSnapTime=0; // snapshot terakhir dari server (dipakai mpInterpolate utk tau ids yg terlihat)
var mpHudDirty=false;
var mpWaterGrid=null,mpWaterCols=0,mpWaterRows=0,mpWaterCell=100,mpWaterSpd=0.4;
var MP_MS=50; // HARUS SAMA PERSIS dgn MS di server/sim.js - kecepatan dasar bidak (px/detik)
function mpIsWater(x,y){
 if(!mpWaterGrid)return false;
 var gx=Math.floor(x/mpWaterCell),gy=Math.floor(y/mpWaterCell);
 if(gx<0||gy<0||gx>=mpWaterCols||gy>=mpWaterRows)return false;
 var bitIdx=gy*mpWaterCols+gx,byteV=mpWaterGrid[bitIdx>>3];
 return ((byteV>>(bitIdx&7))&1)===1;
}
function mpZoneSpd(x,y){
 if(!hz)return 1;
 for(var i=0;i<hz.length;i++){var z=hz[i];if(z.t!=="lumpur")continue;var dx=x-z.x,dy=y-z.y;if(dx*dx+dy*dy<z.r*z.r)return 0.55}
 return 1;
}
function mpClientSpeed(x,y){ return MP_MS*mpZoneSpd(x,y)*(mpIsWater(x,y)?mpWaterSpd:1) }
var SERVER_URL=(window.WAR_SERVER_URL||"wss://GANTI-DENGAN-DOMAIN-RAILWAY.up.railway.app");

function mpLoadPhotoImgs(){
 for(var i=0;i<8;i++){
  var pl=mpPlayers[i];
  if(pl&&pl.photo&&!mpPhotoImgs[i]){var im=new Image();im.src=pl.photo;mpPhotoImgs[i]=im}
  else if(!pl){mpPhotoImgs[i]=null}
 }
}
function mpSend(o){ if(mpWs&&mpWs.readyState===1) mpWs.send(JSON.stringify(o)) }
function mpFilledCount(){ var n=0;for(var i=0;i<8;i++)if(mpPlayers[i])n++;return n }

// mode: "party" (Cari Teman, isi tim HIJAU bareng teman) atau "match" (Cari Match, dipasangkan otomatis).
// vs: "ai" atau "pvp". teamSize: 1-4 (1v1 s/d 4v4).
function mpConnect(name,photo,vs,teamSize,joinMode,onStatus){
 mpMode=vs;mpTeamSize=teamSize;
 onStatus("Menyambung ke server...");
 try{ mpWs=new WebSocket(SERVER_URL) }catch(e){ onStatus("Alamat server tidak valid."); return }
 var opened=false;
 var connTimer=setTimeout(function(){ if(!opened){ onStatus("Server tidak merespons (10 dtk). Cek alamat server / coba lagi."); if(window.mpLobbyBusy)window.mpLobbyBusy(); try{mpWs.close()}catch(e){} } },10000);
 mpWs.onopen=function(){
  opened=true;clearTimeout(connTimer);
  onStatus(joinMode==="party"?"Mencari/membuat party...":"Mencari match...");
  mpSend({type:joinMode,vs:vs,teamSize:teamSize,name:name,photo:photo});
 };
 mpWs.onerror=function(){ clearTimeout(connTimer);onStatus("Gagal terhubung ke server. Cek alamat wss:// dan koneksi internet."); if(window.mpLobbyBusy)window.mpLobbyBusy() };
 mpWs.onclose=function(ev){
  clearTimeout(connTimer);
  if(mpGameStarted&&!mpEnded) mpShowGameEnd("KONEKSI KE SERVER TERPUTUS");
  else if(!mpGameStarted){
   onStatus(ev&&ev.code===1009?"Data terlalu besar (foto profil). Pilih foto lain atau tanpa foto.":"Koneksi ke server terputus (kode "+(ev?ev.code:"?")+"). Coba lagi.");
   if(window.mpLobbyBusy)window.mpLobbyBusy();
  }
 };
 mpWs.onmessage=function(ev){
  var m; try{m=JSON.parse(ev.data)}catch(e){return}
  if(m.type==="assignOwner"){ mpMyOwner=m.owner;mpMyTeam=m.team }
  else if(m.type==="busy"){ onStatus(m.message); if(window.mpLobbyBusy)window.mpLobbyBusy() }
  else if(m.type==="party"){ if(window.mpPartyInfo)window.mpPartyInfo(m) }
  else if(m.type==="lobby"){
   mpPlayers=m.players;mpLoadPhotoImgs();
   var n=mpFilledCount();
   var s=Math.ceil((m.startsInMs||0)/1000);
   onStatus("Menunggu pemain ("+n+"/"+(m.teamSize*2)+")"+(m.startsInMs!=null?" — mulai dlm "+s+" dtk":""));
   if(window.mpRenderLobbyList)window.mpRenderLobbyList(m);
  }
  else if(m.type==="start"){
   mpPlayers=m.players;mpLoadPhotoImgs();mpGameStarted=true;mpMode=m.mode;mpTeamSize=m.teamSize;
   document.getElementById("ov").classList.add("hd");
   mpEnterGame();
   // Zona api/lumpur/air suci dari server -> isi hz agar render() lama menggambarnya
   hz=(m.zones||[]).map(function(z){return {t:z.t,x:z.x,y:z.y,r:z.r,poly:z.poly.map(function(q){return {x:q[0],y:q[1]}})}});
   // Data medan (air laut) dari server - dipakai mpClientSpeed() utk PREDIKSI GERAK (hitung kecepatan
   // sendiri persis spt server, supaya bidak tak pernah "kehabisan tujuan" nunggu snapshot berikutnya).
   if(m.water){
    mpWaterCols=m.water.cols;mpWaterRows=m.water.rows;mpWaterCell=m.water.cell;mpWaterSpd=m.water.spd;
    var bin=atob(m.water.b64),by=new Uint8Array(bin.length);
    for(var wi=0;wi<bin.length;wi++)by[wi]=bin.charCodeAt(wi);
    mpWaterGrid=by;
   }
  }
  else if(m.type==="state"){ mpOnSnapshot(m) }
  else if(m.type==="end"){ mpShowGameEnd(m.reason) }
 };
}

function mpShowGameEnd(reason){
 mpEnded=true;
 var ov=document.getElementById("mpEndOv");
 if(ov){ document.getElementById("mpEndMsg").textContent=reason||"PERTEMPURAN BERAKHIR"; ov.classList.remove("hd"); }
}

// Snapshot dari server -> bangun ulang pc (hanya bidak yg TERLIHAT). Posisi diinterpolasi di mpInterpolate().
function mpOnSnapshot(m){
 var now=performance.now();
 var snapDt=mpSnapTime?Math.max(0.02,Math.min(0.3,(now-mpSnapTime)/1000)):0.1; // jarak wkt antar snapshot, utk ekstrapolasi
 mpSnapTime=now;
 for(var k=0;k<m.t.length&&k<tr.length;k++)tr[k].tm=m.t[k]||"n";
 // Siapkan pc tetap (indeks = indeks asli server, agar sel/perintah cocok). Bidak tak terlihat => hidden.
 mpSnapCur={ids:m.ids};
 var idx={};for(var i=0;i<m.ids.length;i++)idx[m.ids[i]]=m.p[i];
 var maxId=0;for(var q=0;q<m.ids.length;q++)if(m.ids[q]>maxId)maxId=m.ids[q];
 for(var j=0;j<m.gens.length;j++){var g=m.gens[j];if(g&&g[2]>maxId)maxId=g[2]}
 while(pc.length<=maxId)pc.push({x:0,y:0,a:0,t:"B",i:-1,hp:0,mhp:100,gen:false,al:false,hidden:true,owner:0,team:"B",hf:0,ord:null,tgt:null,orbiting:null,rt:false,obey:false,form:null,formAng:0,mem:0,gtx:null,gty:null,srvX:0,srvY:0,srvA:0});
 for(var n=0;n<pc.length;n++){ if(!idx[n]){ pc[n].al=false;pc[n].hidden=true } }
 for(var r=0;r<m.ids.length;r++){
  var id=m.ids[r],d=m.p[r],o=pc[id];
  var wasAl=o.al&&!o.hidden;
  // srvX/Y/A = posisi ASLI terakhir dari server (kebenaran utk koreksi). x/y/a = posisi PREDIKSI yg
  // digambar (digerakkan sendiri oleh client tiap frame di mpInterpolate, bkn cuma interpolasi 2 titik).
  // srvX/Y = posisi ASLI dari server, apa adanya (TANPA ekstrapolasi tambahan - client sudah
  // memprediksi gerak sendiri lewat gtx/gty di mpInterpolate, menambah ekstrapolasi di SINI JUGA
  // cuma menggandakan prediksi & menyebabkan lompatan tiap snapshot baru tiba, bukan mulus).
  o.srvX=d[0];o.srvY=d[1];o.srvA=d[2];
  if(!wasAl){o.x=d[0];o.y=d[1];o.a=d[2];o.px=d[0];o.py=d[1];o.corX=0;o.corY=0} // baru muncul/respawn: langsung di posisi
  o.t=d[3]?"A":"B";o.team=o.t;o.i=d[4];o.hp=d[5];o.mhp=d[6];o.gen=!!d[7];o.owner=d[8];o.hf=d[9]?0.2:0;o.ord=d[10]?"move":null;
  o.gtx=d[11];o.gty=d[12];
  o.al=true;o.hidden=false;
 }
 for(var oi=0;oi<8;oi++){ var gg=m.gens[oi]; pgens[oi]=(gg&&gg[0])?pc[gg[2]]:null; }
 pgen=pgens[mpMyOwner];
 mpRespawnLeft=m.rs;mpGameMin=m.min;
 // HUD: "pC"/"eC" skrng berarti jml bidak TERLIHAT milik timku vs tim lawan (bukan lagi sekutu/musuh AI)
 var myAl=0,enAl=0;
 for(var e3=0;e3<m.p.length;e3++){ if(m.p[e3][3]===(mpMyTeam==="A"?1:0))myAl++; else enAl++; }
 document.getElementById("pC").textContent=myAl;
 document.getElementById("eC").textContent=enAl;
 document.getElementById("tC").textContent="Hijau "+m.cA+"/20 — Merah "+m.cB+"/20";
 var me=m.gens[mpMyOwner];
 document.getElementById("gH").textContent=me?me[1]:0;
 if(m.toasts){for(var ti=0;ti<m.toasts.length;ti++)tK(m.toasts[ti])}
}

// ====== PREDIKSI GERAK CLIENT (client-side prediction) ======
// Tiap bidak bergerak sendiri (BUKAN nunggu snapshot) menuju gtx/gty dgn kecepatan medan yg
// dihitung client sendiri - bidak TERUS jalan mulus walau snapshot server (10x/detik) telat/hilang.
// Koreksi ke srvX/Y (posisi asli server) dibuat SANGAT PELAN & konstan (MP_CORRECT_RATE rendah):
// diuji sistematis beberapa nilai, rate rendah (2-4/detik) terbukti PALING MULUS (nyaris tak pernah
// memicu lompatan terlihat) justru krn koreksinya nyaris tak kerasa - cukup utk mencegah penyimpangan
// menumpuk tanpa batas dlm jangka panjang, tanpa pernah terasa sbg "tarikan" di gerakan sesaat.
// Snap instan HANYA utk penyimpangan ekstrem (respawn/teleport sungguhan), lihat MP_SNAP_THRESHOLD.
var MP_CORRECT_RATE=3; // per detik - JANGAN dinaikkan tanpa pengujian; nilai lebih tinggi terbukti
                       // menciptakan lompatan lebih besar & lebih sering (sudah diuji 2/4/6/8/12/16/24)
var MP_SNAP_THRESHOLD=250; // px; selisih di atas ini dianggap teleport (respawn dll), snap instan

function mpInterpolate(dt){
 dt=dt||(1/60);
 var ids=mpSnapCur?mpSnapCur.ids:[];
 for(var n=0;n<ids.length;n++){
  var id=ids[n],o=pc[id];
  if(!o||!o.al||o.hidden)continue;

  // PREDIKSI: majukan ke arah gtx/gty dgn kecepatan medan (air/lumpur dihitung sendiri oleh client).
  if(o.gtx!=null&&o.gty!=null){
   var ddx=o.gtx-o.x,ddy=o.gty-o.y,dist=Math.sqrt(ddx*ddx+ddy*ddy);
   if(dist>2){
    var spd=mpClientSpeed(o.x,o.y),step=spd*dt;
    if(step>=dist){o.x=o.gtx;o.y=o.gty}
    else{o.x+=ddx/dist*step;o.y+=ddy/dist*step}
    o.a=Math.atan2(ddy,ddx);
   }
  }

  // KOREKSI: tarikan SANGAT pelan & konstan ke posisi server, mencegah penyimpangan menumpuk tanpa
  // pernah terasa sbg sentakan (rate rendah = tarikan per frame sangat kecil, hampir tak terlihat).
  var cdx=o.srvX-o.x,cdy=o.srvY-o.y,cdist2=cdx*cdx+cdy*cdy;
  if(cdist2>MP_SNAP_THRESHOLD*MP_SNAP_THRESHOLD){
   o.x=o.srvX;o.y=o.srvY;o.a=o.srvA; // penyimpangan ekstrem (respawn/teleport): snap instan
  } else if(cdist2>0.25){
   var pull=Math.min(1,MP_CORRECT_RATE*dt);
   o.x+=cdx*pull;o.y+=cdy*pull;
  }
 }
}

// ====== INPUT (client -> server) ======
function mpSendOrApplyInput(cmdType,payload){ mpSend({type:"input",cmd:cmdType,payload:payload}) }

// PETA LATAR (gambar acuan dunia nyata, dipakai sbg background & acuan bentuk wilayah)
var bgImg=new Image();
var bgReady=false;
bgImg.onload=function(){bgReady=true;mcDirty=true};
bgImg.src="data:image/jpeg;base64,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";

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
  if(te.tm==="A"){mcCtx.fillStyle="rgba(74,154,74,.45)";mcCtx.fill();}
  else if(te.tm==="B"){mcCtx.fillStyle="rgba(196,64,64,.45)";mcCtx.fill();}
  mcCtx.strokeStyle=te.tm==="A"?"#4a9a4a":te.tm==="B"?"#c44040":te.bc;mcCtx.lineWidth=0.7;mcCtx.stroke();
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

function mkP(x,y,t,i){return{x:x,y:y,t:t,i:i,a:t==="A"?0:Math.PI,ox:x,oy:y,ord:null,gtx:null,gty:null,tgt:null,zone:null,orbiting:null,orbitDir:(Math.random()>0.5?1:-1),gid:0,al:true,hp:100,mhp:100,gen:false,rt:false,rt2:0,hf:0,eng:null,moc:0,obey:false,form:null,formAng:0,gotoBlock:false,slotIdx:0,hidden:false,owner:0,team:null}}



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

 for(var i=0;i<pc.length;i++){var p=pc[i];if(!p.al||p.owner!==mpMyOwner)continue;if(p.x>=lx&&p.x<=rx&&p.y>=ly&&p.y<=ry)sel.add(i)}

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

 mpSendOrApplyInput("orderMove",{ids:Array.from(sel),bx:bx,by:by,formMode:formMode,moveMode:moveMode,genMode:genMode});
 return;

 var idxs=Array.from(sel);
 var gIdx=-1;
 if(formMode&&idxs.length>1){var gi=idxs.indexOf(pgenIdx);if(gi>=0){gIdx=pgenIdx;idxs.splice(gi,1)}}
 var gK=(gIdx>=0&&formMode==="globus"&&genMode==="tengah")?Math.min(globusHoleCount(3),30):0;
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
 if(gIdx<0&&idxs.indexOf(pgenIdx)>=0){
  var g2=pc[pgenIdx];
  g2.baseGtx=bx;g2.baseGty=by;g2.gotoOrder=isGoto;g2.formSnap=null;g2.genModeSnap=null;
 }

 if(gIdx>=0){ // jenderal: dapat slot sendiri di grup formasi (bukan individu terpisah), posisi sesuai tombol "Jendral: ..."
  var g=pc[gIdx];
  var gox=0,goy=0;
  if(genMode!=="tengah"){
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
   if(genMode==="kiri"){gox=minOx-margin;goy=(minOy+maxOy)/2}
   else if(genMode==="kanan"){gox=maxOx+margin;goy=(minOy+maxOy)/2}
   else if(genMode==="atas"){goy=minOy-margin;gox=(minOx+maxOx)/2}
   else if(genMode==="bawah"){goy=maxOy+margin;gox=(minOx+maxOx)/2}
  }
  g.obey=true;g.ord="move";g.tgt=null;g.zone=null;g.eng=null;g.rt=false;g.orbiting=null;g.gotoBlock=false;
  g.form=null;g.gid=gid;g.ox=0;g.oy=0;g.gtx=bx+gox;g.gty=by+goy;
  g.baseGtx=g.gtx;g.baseGty=g.gty; // target dasar formasi, dipakai utk balik lagi setelah jendral selesai siaga/sembunyi
  // Snapshot mode formasi/genMode/GoTo saat perintah ini diberikan - dipakai SIAGA runtime utk tahu
  // apakah jendral skrg "terlindungi penuh" (globus+tengah = terkurung 360° bidak sendiri) atau
  // sedang GoTo (wajib patuh lurus spt bidak biasa, tak boleh kabur menyimpang formasi/barisan).
  g.formSnap=formMode;g.genModeSnap=genMode;g.gotoOrder=isGoto;
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
    if(isWater(pt.x,pt.y)||ds(pt,pgen)<400||(te.gp&&ds(pt,te.gp)<r+120))continue;
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
 if(pgen&&pgen.al){
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
 if(pgen){
  pgen.rt=false;
  document.getElementById("gH").textContent=Math.max(0,Math.round(pgen.hp/pgen.mhp*100));
  if(pgen.hp<pgen.mhp*0.4&&!pgen.warn&&pgen.al){pgen.warn=true;tK("JENDERAL TERANCAM!")}
  else if(pgen.hp>pgen.mhp*0.6)pgen.warn=false;
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
    if(oi===mpMyOwner)tK("Jenderalmu gugur! Respawn dlm "+Math.round(mpRespawnDelaySec())+" detik...");
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

  // Wilayah: HIJAU = tim A (markas Hutan Sancang), MERAH = tim B (markas Giri Kancana), warna asli = netral
  cx.fillStyle=te.tm==="A"?"rgba(74,154,74,.22)":te.tm==="B"?"rgba(196,64,64,.22)":te.cl;cx.fill();

  cx.setLineDash([6*cam.z,4*cam.z]);

  cx.strokeStyle=te.tm==="A"?"#4a9a4a":te.tm==="B"?"#c44040":te.bc;

  cx.lineWidth=Math.max(1,1.5*cam.z);cx.stroke();cx.setLineDash([]);

  var c=b2s(te.cx,te.cy),r=te.r*cam.z;

  cx.fillStyle=te.tm==="A"?"#bfe6bf":te.tm==="B"?"#ffd0d0":"#fff7d8";

  cx.strokeStyle="rgba(0,0,0,.85)";cx.lineWidth=Math.max(0.9,3.6*cam.z);

  cx.font="bold "+Math.max(10.5,16.5*cam.z)+"px monospace";cx.textAlign="center";

  cx.strokeText(te.nm,c.x,c.y);

  cx.fillText(te.nm,c.x,c.y);

  if(te.tm==="A"||te.tm==="B"){
   var tkY=c.y+Math.max(15,19*cam.z),tkLabel=te.tm==="A"?"[HIJAU]":"[MERAH]",tkCol=te.tm==="A"?"#bfe6bf":"#ffd0d0";
   cx.fillStyle=tkCol;cx.strokeText(tkLabel,c.x,tkY);cx.fillText(tkLabel,c.x,tkY);
  }

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
  // Tim vs tim: pandangan terbuka (tidak ada fog of war global) - kedua tim saling melihat spt
  // game RTS pada umumnya, krn ini kompetitif (PvP/PvE), bukan kooperatif dgn "kabut perang" lawan.
  var myTeam=OWNER_TEAM[mpMyOwner];
  var isP=p.team===myTeam,ppA=p.a+Math.PI/2,isMyGen=isP&&p.gen&&p.owner===mpMyOwner; // isMyGen = jendral pemain LOKAL (pakai foto profil sendiri)
  var isOtherGen=isP&&p.gen&&p.owner!==mpMyOwner; // jendral rekan SETIM lain (pakai foto profil masing2)
  var ownerColor=OWNER_COLORS[p.owner]||(p.team==="A"?"#4a9a4a":"#c44040");



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

  cx.fillStyle=p.team==="A"?"#3a5a1a":"#5a1a1a";cx.fill(); // belakang: gelap hijau (tim A) / gelap merah (tim B)



  // Setengah depan

  cx.beginPath();cx.moveTo(s.x,s.y);cx.arc(s.x,s.y,r,p.a-Math.PI/2,p.a+Math.PI/2);cx.closePath();

  cx.fillStyle=p.hf>0?"#fff":ownerColor;cx.fill();



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

  cx.closePath();cx.fillStyle=ownerColor;cx.fill();



  if(p.gen){cx.beginPath();cx.arc(s.x,s.y,r*1.2,0,Math.PI*2);cx.strokeStyle=ownerColor;cx.lineWidth=Math.max(1.5,2.5*cam.z);cx.stroke()}
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

  // Nama jendral TIM LAWAN di atas badannya - sama gayanya spt nama jendral tim sendiri
  if(!isP&&p.gen){
   var enName=(mpPlayers[p.owner]&&mpPlayers[p.owner].name)||OWNER_NAMES[p.owner];
   cx.font="bold "+Math.max(9,12*cam.z)+"px monospace";
   cx.textAlign="center";cx.textBaseline="alphabetic";
   var enmY=s.y-r-20*cam.z;
   cx.lineWidth=Math.max(2,3*cam.z);cx.strokeStyle="#000";cx.strokeText(enName,s.x,enmY);
   cx.fillStyle="#fff";cx.fillText(enName,s.x,enmY);
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

  mx.fillStyle=OWNER_COLORS[p.owner]||(p.team==="A"?"#4a9a4a":"#c44040");

  if(p.gen){mx.fillStyle="#fff";mx.fillRect(p.x*sx-1.5,p.y*sy-1.5,3,3)}else mx.fillRect(p.x*sx-0.5,p.y*sy-0.5,1.5,1.5);

 }

 var vx=(cam.x-cv.width/2/cam.z)*sx,vy=(cam.y-cv.height/2/cam.z)*sy;

 var vw=cv.width/cam.z*sx,vh=cv.height/cam.z*sy;

 mx.strokeStyle="#d4a832";mx.lineWidth=0.8;mx.strokeRect(vx,vy,vw,vh);

}



// GAME LOOP

// HUD respawn & menit: tampilkan hitung mundur kalau jenderal kita gugur
function mpTickHud(){
 var el=document.getElementById("mpRespawnHud");
 if(!el){
  el=document.createElement("div");el.id="mpRespawnHud";
  el.style.cssText="position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:30;font:bold 13px monospace;color:#fff;background:rgba(0,0,0,.6);border:1px solid #c44040;padding:6px 14px;border-radius:4px;display:none;pointer-events:none";
  document.body.appendChild(el);
 }
 var left=mpRespawnLeft[mpMyOwner]|0;
 if(left>0&&!mpEnded){el.style.display="block";el.textContent="Jenderalmu gugur — respawn "+left+" dtk"}
 else el.style.display="none";
}

function gl(t){

 if(mpEnded){requestAnimationFrame(gl);return}

 var dt=Math.min((t-lt)/1000,0.05);

 lt=t;

 // Client TIDAK menjalankan simulasi penuh (update/combat/AI) - server tetap authoritative utk itu.
 // Tapi utk GERAK, client memprediksi sendiri tiap frame (lihat mpInterpolate) spy mulus walau
 // snapshot server (10x/detik) telat/jitter - server cuma MENGOREKSI kalau prediksi meleset.
 mpInterpolate(dt);
 mpTickHud();

 render();

 requestAnimationFrame(gl);

}



function mpEnterGame(){
 iTr();
 iRocks();
 pc=[];
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

