(function(){
 var wrap=document.getElementById("ppWrap"),fileInp=document.getElementById("ppFile"),imgEl=document.getElementById("ppImg"),ph=document.getElementById("ppPh");
 var nameInp=document.getElementById("pName"),cnt=document.getElementById("pNameCnt");
 wrap.onclick=function(){fileInp.click()};
 fileInp.onchange=function(){
  var f=fileInp.files&&fileInp.files[0];if(!f)return;
  var rd=new FileReader();
  rd.onload=function(){
   var im=new Image();
   im.onload=function(){
    var S=128,cv2=document.createElement("canvas");cv2.width=S;cv2.height=S;
    var c2=cv2.getContext("2d"),side=Math.min(im.width,im.height);
    c2.drawImage(im,(im.width-side)/2,(im.height-side)/2,side,side,0,0,S,S);
    var small=cv2.toDataURL("image/jpeg",0.8);
    var im2=new Image();im2.onload=function(){playerPhotoImg=im2;playerPhotoDataURL=small};im2.src=small;
   };
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

 // ====== LOBI BERTINGKAT: pilih lawan -> pilih mode -> cari teman/cari match ======
 var stepVs=document.getElementById("stepVs"),stepMode=document.getElementById("stepMode"),stepJoin=document.getElementById("stepJoin");
 var bVsPlayer=document.getElementById("bVsPlayer"),bVsAi=document.getElementById("bVsAi");
 var modeBts=document.querySelectorAll(".modeBt"),modeTitle=document.getElementById("modeTitle"),joinTitle=document.getElementById("joinTitle");
 var bBackVs=document.getElementById("bBackVs"),bBackMode=document.getElementById("bBackMode");
 var bCariTeman=document.getElementById("bCariTeman"),bCariMatch=document.getElementById("bCariMatch"),bCancel=document.getElementById("bCancel");
 var playerListEl=document.getElementById("mpPlayerList"),statusEl=document.getElementById("mpStatus");
 var ovSub=document.getElementById("ovSub");

 var chosenVs="pvp",chosenN=1;

 function showStep(el){
  [stepVs,stepMode,stepJoin].forEach(function(s){s.classList.add("hd")});
  el.classList.remove("hd");
 }
 function setStatus(t){statusEl.textContent=t||""}
 function curName(){ return (nameInp.value||"").trim().slice(0,20)||"Jenderal" }

 bVsPlayer.onclick=function(){
  chosenVs="pvp";
  modeTitle.textContent="MODE — VS PLAYER";
  ovSub.textContent="Lawan pemain sungguhan. Pilih ukuran tim.";
  showStep(stepMode);
 };
 bVsAi.onclick=function(){
  chosenVs="ai";
  modeTitle.textContent="MODE — VS AI";
  ovSub.textContent="Lawan bot AI. Pilih ukuran tim.";
  showStep(stepMode);
 };
 bBackVs.onclick=function(){ showStep(stepVs) };
 bBackMode.onclick=function(){
  if(mpWs){try{mpSend({type:"cancel"});mpWs.close()}catch(e){}}
  bCancel.style.display="none";bCariTeman.style.display="block";bCariMatch.style.display="block";
  mpPlayers=new Array(8).fill(null);renderPlayerList();setStatus("");
  showStep(stepMode);
 };

 modeBts.forEach(function(b){
  b.onclick=function(){
   modeBts.forEach(function(x){x.classList.remove("ac")});
   b.classList.add("ac");
   chosenN=parseInt(b.getAttribute("data-n"),10);
   joinTitle.textContent=chosenN+"v"+chosenN+" — "+(chosenVs==="ai"?"VS AI":"VS PLAYER");
   showStep(stepJoin);
  };
 });

 function renderPlayerList(lobbyMsg){
  var html="",n=lobbyMsg?lobbyMsg.teamSize:chosenN;
  for(var team=0;team<2;team++){
   html+='<div style="font-size:9px;color:'+(team===0?"#4a9a4a":"#c44040")+';margin-top:4px">'+(team===0?"TIM HIJAU":"TIM MERAH")+'</div>';
   for(var k=0;k<n;k++){
    var i=team*4+k,pl=mpPlayers[i];
    if(!pl){ html+='<div class="mpPlItem" style="opacity:.4">(kosong)</div>'; continue }
    var photoHtml=pl.photo?'<img src="'+pl.photo+'">':'<span class="mpDot" style="background:'+OWNER_COLORS[i]+'"></span>';
    html+='<div class="mpPlItem">'+photoHtml+' '+pl.name+(i===mpMyOwner?" (kamu)":"")+(pl.bot?" [BOT]":"")+'</div>';
   }
  }
  playerListEl.innerHTML=html;
 }
 window.mpRenderLobbyList=renderPlayerList;
 window.mpSetStatus=setStatus;
 window.mpLobbyBusy=function(){
  bCariTeman.style.display="block";bCariMatch.style.display="block";bCancel.style.display="none";
 };
 window.mpPartyInfo=function(m){
  setStatus("Party dibuat. Bagikan & tunggu teman bergabung, atau lawan akan dicari otomatis.");
 };

 bCariTeman.onclick=function(){
  playerName=curName();
  bCariTeman.style.display="none";bCariMatch.style.display="none";bCancel.style.display="block";
  mpConnect(playerName,playerPhotoDataURL,chosenVs,chosenN,"party",setStatus);
 };
 bCariMatch.onclick=function(){
  playerName=curName();
  bCariTeman.style.display="none";bCariMatch.style.display="none";bCancel.style.display="block";
  mpConnect(playerName,playerPhotoDataURL,chosenVs,chosenN,"match",setStatus);
 };
 bCancel.onclick=function(){
  if(mpWs){try{mpSend({type:"cancel"});mpWs.close()}catch(e){}}
  bCancel.style.display="none";bCariTeman.style.display="block";bCariMatch.style.display="block";
  mpPlayers=new Array(8).fill(null);renderPlayerList();setStatus("");
 };
})();
