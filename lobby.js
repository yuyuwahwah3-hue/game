

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

 // ====== LOBBY MATCHMAKING (server dedicated) ======
 var bFind=document.getElementById("bFind"),bCancel=document.getElementById("bCancel");
 var playerListEl=document.getElementById("mpPlayerList"),statusEl=document.getElementById("mpStatus");
 function setStatus(t){statusEl.textContent=t}
 function curName(){ return (nameInp.value||"").trim().slice(0,20)||"Jenderal" }

 function renderPlayerList(){
  var html="";
  for(var i=0;i<4;i++){
   var pl=mpPlayers[i];
   if(!pl)continue;
   html+='<div class="mpPlItem"><span class="mpDot" style="background:'+OWNER_COLORS[i]+'"></span>'+pl.name+(i===mpMyOwner?" (kamu)":"")+'</div>';
  }
  playerListEl.innerHTML=html;
 }
 window.mpRenderLobbyList=renderPlayerList;
 window.mpSetStatus=setStatus;
 window.mpLobbyBusy=function(){bFind.style.display="block";bFind.disabled=false;bCancel.style.display="none"};

 bFind.onclick=function(){
  playerName=curName();
  bFind.style.display="none";bCancel.style.display="block";
  mpConnect(playerName,playerPhotoDataURL,setStatus);
 };
 bCancel.onclick=function(){
  if(mpWs){try{mpSend({type:"cancel"});mpWs.close()}catch(e){}}
  bCancel.style.display="none";bFind.style.display="block";
  mpPlayers=[null,null,null,null];renderPlayerList();setStatus("");
 };
})();
