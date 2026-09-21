const $=id=>document.getElementById(id);
let songs=[],visible=60,filtered=[],currentStatus=null,toastTimer,qrTimer,localLogin=false;
let selectedRoomId=localStorage.getItem('sonos-room-id')||'',roomData=null,chosenSong=null,chosenQueueTrack=null,queueTotal=0;
let seeking=false,volumeDragging=false,volumeDesired=null,volumeSending=false,artUrl='';
let lyrics=[],lyricTrack='',lyricMessage='正在读取歌词…',activeLyricIndex=-2;
let positionAnchor={seconds:0,at:Date.now(),playing:false};
let statusRequest=0,transportSettlingUntil=0,expectedPlaying=null,expectedPosition=null;
const themeProperties=['--page-bg','--page-glow','--surface','--surface-deep','--surface-raised','--border','--accent'];
function resetSongTheme(){for(const name of themeProperties)document.documentElement.style.removeProperty(name);}
function rgbToHsl(r,g,b){
  r/=255;g/=255;b/=255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),difference=max-min;
  let hue=0,saturation=0,lightness=(max+min)/2;
  if(difference){
    saturation=difference/(1-Math.abs(2*lightness-1));
    switch(max){case r:hue=((g-b)/difference)%6;break;case g:hue=(b-r)/difference+2;break;default:hue=(r-g)/difference+4;}
    hue=(hue*60+360)%360;
  }
  return {hue,saturation,lightness};
}
function applySongTheme(image){
  try{
    const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    context.drawImage(image,0,0,24,24);
    const pixels=context.getImageData(0,0,24,24).data;
    const buckets=Array.from({length:18},()=>({weight:0,x:0,y:0,saturation:0}));
    for(let i=0;i<pixels.length;i+=4){
      if(pixels[i+3]<180)continue;
      const color=rgbToHsl(pixels[i],pixels[i+1],pixels[i+2]);
      if(color.saturation<.16||color.lightness<.12||color.lightness>.88)continue;
      const weight=Math.min(color.saturation,.65);
      const bucket=buckets[Math.floor(color.hue/20)];
      bucket.weight+=weight;bucket.x+=Math.cos(color.hue*Math.PI/180)*weight;
      bucket.y+=Math.sin(color.hue*Math.PI/180)*weight;
      bucket.saturation+=color.saturation*weight;
    }
    const best=buckets.reduce((a,b)=>b.weight>a.weight?b:a);
    if(best.weight<3){resetSongTheme();return;}
    const hue=(Math.atan2(best.y,best.x)*180/Math.PI+360)%360;
    const saturation=Math.round(Math.min(36,Math.max(18,best.saturation/best.weight*42)));
    const root=document.documentElement.style;
    root.setProperty('--page-bg',`hsl(${hue.toFixed(0)} ${saturation}% 11%)`);
    root.setProperty('--page-glow',`hsl(${hue.toFixed(0)} ${saturation+5}% 22%)`);
    root.setProperty('--surface',`hsl(${hue.toFixed(0)} ${Math.max(12,saturation-6)}% 17%)`);
    root.setProperty('--surface-deep',`hsl(${hue.toFixed(0)} ${Math.max(10,saturation-6)}% 14%)`);
    root.setProperty('--surface-raised',`hsl(${hue.toFixed(0)} ${Math.max(12,saturation-6)}% 23%)`);
    root.setProperty('--border',`hsl(${hue.toFixed(0)} ${Math.max(10,saturation-10)}% 30%)`);
    root.setProperty('--accent',`hsl(${hue.toFixed(0)} ${Math.min(52,saturation+16)}% 77%)`);
  }catch{resetSongTheme();}
}
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),4000);}
async function api(path,options){
  const url=new URL(path,location.href);
  if(selectedRoomId&&!url.searchParams.has('room')&&(/^\/api\/(status|control|queue|sleep|play)(?:\/|$)/).test(url.pathname))url.searchParams.set('room',selectedRoomId);
  const response=await fetch(url,options),data=await response.json();if(!response.ok)throw Error(data.error||`请求失败：${response.status}`);return data;
}
function duration(seconds){return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function timecode(value){const p=String(value||'0:00').split(':').map(Number);return p.length===3?p[0]*3600+p[1]*60+p[2]:p.length===2?p[0]*60+p[1]:0;}
function renderLyricList(){
  const list=$('lyrics-list');
  if(!lyrics.length){list.textContent=lyricMessage;return;}
  const fragment=document.createDocumentFragment();
  for(const line of lyrics){const row=document.createElement('div');row.className='lyric-line';row.textContent=line.text;fragment.append(row);}
  list.replaceChildren(fragment);
  activeLyricIndex=-2;
}
function scrollActiveLyric(){
  const list=$('lyrics-list'),active=list.querySelector('.lyric-line.active');
  if(active)list.scrollTo({top:active.offsetTop-list.clientHeight/2+active.offsetHeight/2,behavior:'smooth'});
}
function renderLyricsAt(seconds){
  if(!lyrics.length){$('lyric-current').textContent=lyricMessage;$('lyric-next').textContent='';$('mini-lyric-open').textContent=lyricMessage;return;}
  let index=-1;
  for(let i=0;i<lyrics.length&&lyrics[i].time<=seconds;i++)index=i;
  const current=index<0?'即将开始':lyrics[index].text;
  $('lyric-current').textContent=current;$('lyric-next').textContent=lyrics[index+1]?.text||'';
  $('mini-lyric-open').textContent=current;
  if(index===activeLyricIndex)return;
  const rows=$('lyrics-list').children;
  if(activeLyricIndex>=0)rows[activeLyricIndex]?.classList.remove('active');
  if(index>=0){rows[index]?.classList.add('active');if($('lyrics-dialog').open)scrollActiveLyric();}
  activeLyricIndex=index;
}
async function loadLyricsFor(s){
  const key=String(s.songId||0);
  if(key===lyricTrack)return;
  lyricTrack=key;lyrics=[];lyricMessage=s.songId?'正在读取歌词…':'当前音源暂无歌词';renderLyricList();renderLyricsAt(timecode(s.position));
  if(!s.songId)return;
  try{
    const data=await api(`/api/lyrics?id=${encodeURIComponent(s.songId)}`);
    if(lyricTrack!==key)return;
    lyrics=data.lines||[];lyricMessage=lyrics.length?'':'当前歌曲暂无逐行歌词';
  }catch(e){if(lyricTrack!==key)return;lyricMessage='歌词暂不可用';}
  renderLyricList();renderLyricsAt(positionAnchor.seconds+(positionAnchor.playing?(Date.now()-positionAnchor.at)/1000:0));
}
function renderStatus(s){
  currentStatus=s;
  $('connection').textContent=`● ${s.room} · 已连接`;$('connection').className='connection ok';
  $('room').textContent=s.room;$('model').textContent=s.model;
  $('track-title').textContent=s.title||'暂无播放曲目';$('track-artist').textContent=s.artist||'从下方歌单选择歌曲';
  $('mini-title').textContent=s.title||'暂无播放曲目';$('mini-artist').textContent=s.artist||s.room;
  $('lyrics-title').textContent=s.title||'歌词';$('lyrics-artist').textContent=s.artist||'';
  $('room-menu-name').textContent=s.room;
  for(const [id,value] of [['repeat-all',s.repeatAll],['crossfade',s.crossfade]]){$(id).classList.toggle('active',Boolean(value));$(id).setAttribute('aria-pressed',String(Boolean(value)));}
  $('group-controls').hidden=s.groupSize<2;
  if(s.groupSize>1){$('group-volume').value=s.groupVolume;$('group-volume-value').textContent=`${s.groupVolume}%`;}
  positionAnchor={seconds:timecode(s.position),at:Date.now(),playing:s.playing};
  const length=timecode(s.duration);
  for(const prefix of ['','mini-']){
    const play=$(prefix+'toggle-play'),shuffle=$(prefix+'shuffle'),repeat=$(prefix+'repeat-one'),mute=$(prefix+'mute');
    play.classList.toggle('playing',s.playing);play.setAttribute('aria-label',s.playing?'暂停':'播放');
    shuffle.classList.toggle('active',s.shuffle);shuffle.setAttribute('aria-pressed',String(s.shuffle));shuffle.title=s.shuffle?'关闭随机播放':'随机播放';
    repeat.classList.toggle('active',s.repeatOne);repeat.setAttribute('aria-pressed',String(Boolean(s.repeatOne)));repeat.title=s.repeatOne?'关闭单曲循环':'开启单曲循环';
    mute.classList.toggle('active',s.mute);mute.setAttribute('aria-pressed',String(s.mute));mute.setAttribute('aria-label',s.mute?'取消静音':'静音');mute.title=s.mute?'取消静音':'静音';
    if(!volumeDragging&&!volumeSending){$(prefix+'volume').value=s.volume;$(prefix+'volume-value').textContent=`${s.volume}%`;}
    const seek=$(prefix+'seek');seek.disabled=!length;seek.max=Math.max(1,length);
    if(!seeking){seek.value=Math.min(length,timecode(s.position));$(prefix+'position').textContent=duration(timecode(s.position));}
    $(prefix+'duration').textContent=duration(length);
  }
  if(artUrl!==(s.albumArt||'')){artUrl=s.albumArt||'';resetSongTheme();for(const id of ['album-art','mini-art']){const image=$(id);image.hidden=true;image.removeAttribute('src');if(artUrl)image.src=artUrl;}}
  loadLyricsFor(s);
  renderLyricsAt(positionAnchor.seconds);
  if($('queue-dialog').open)markCurrentQueueTrack();
}
function updateProgress(){
  if(!currentStatus)return;
  const length=timecode(currentStatus.duration);
  const seconds=Math.min(length||Infinity,positionAnchor.seconds+(positionAnchor.playing?(Date.now()-positionAnchor.at)/1000:0));
  if(!seeking){
    for(const prefix of ['','mini-']){
      $(prefix+'position').textContent=duration(Math.floor(seconds));
      if(length)$(prefix+'seek').value=Math.floor(seconds);
    }
  }
  renderLyricsAt(seconds);
}
for(const id of ['album-art','mini-art']){const art=$(id);art.onload=()=>{art.hidden=false;if(id==='album-art')applySongTheme(art);};art.onerror=()=>{art.hidden=true;if(id==='album-art')resetSongTheme();};}
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function livePosition(){
  if(!currentStatus)return 0;
  const length=timecode(currentStatus.duration);
  return Math.min(length||Infinity,positionAnchor.seconds+(positionAnchor.playing?(Date.now()-positionAnchor.at)/1000:0));
}
function renderOptimisticTransport(playing,position=livePosition()){
  if(!currentStatus)return;
  renderStatus({...currentStatus,playing,position:duration(Math.floor(position))});
}
function beginTransportSync(playing,position){
  expectedPlaying=playing;
  expectedPosition=Number.isFinite(position)?position:null;
  transportSettlingUntil=Date.now()+6500;
  renderOptimisticTransport(playing,position);
}
async function updateStatus(){
  const request=++statusRequest;
  try{
    const status=await api('/api/status');
    if(request!==statusRequest)return null;
    const awaitingExpectedState=expectedPlaying!==null&&transportSettlingUntil>Date.now();
    const positionPending=expectedPosition!==null&&Math.abs(timecode(status.position)-expectedPosition)>2;
    if(awaitingExpectedState&&(status.playing!==expectedPlaying||positionPending)){
      // Sonos briefly reports the previous transport state while applying a command.
      renderStatus({...status,playing:expectedPlaying,position:positionPending?duration(expectedPosition):status.position});
      return null;
    }
    renderStatus(status);
    return status;
  }catch(e){
    $('connection').textContent='● 音响未连接';$('connection').className='connection error';
    if(!currentStatus)toast(e.message);
    return null;
  }
}
async function settleTransport(playing){
  const deadline=Date.now()+6500;
  let matchingReports=0;
  while(Date.now()<deadline){
    const status=await updateStatus();
    if(status?.playing===playing){
      matchingReports++;
      if(matchingReports>=2){expectedPlaying=null;expectedPosition=null;transportSettlingUntil=0;return;}
    }else matchingReports=0;
    await delay(350);
  }
  expectedPlaying=null;expectedPosition=null;transportSettlingUntil=0;
  await updateStatus();
}
async function playSong(song,row){
  const fromSearch=Boolean(row.closest('#quick-search-results'));
  row.disabled=true;row.classList.add('loading');
  try{
    await api('/api/play',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mid:song.mid})});
    beginTransportSync(true);toast(`正在播放：${song.title}`);await settleTransport(true);
    if(fromSearch)$('quick-search-state').textContent=`正在播放：${song.title}`;
  }catch(e){toast(e.message);if(fromSearch)$('quick-search-state').textContent=e.message;}
  finally{row.disabled=false;row.classList.remove('loading');}
}
function createSongRow(song){
  const entry=document.createElement('div');entry.className='song-entry';
  const row=document.createElement('button');row.type='button';row.className='song';
  row.setAttribute('aria-label',`播放 ${song.title}，${song.artist}`);
  const number=document.createElement('span');number.className='song-index';number.textContent=song.index;
  const info=document.createElement('span');info.className='song-info';
  const name=document.createElement('span');name.className='song-name';name.textContent=song.title;
  const artist=document.createElement('span');artist.className='song-sub';artist.textContent=song.artist;
  info.append(name,artist);
  const album=document.createElement('span');album.className='song-album';album.textContent=song.album;
  const length=document.createElement('span');length.className='song-duration';length.textContent=duration(song.duration);
  row.onclick=()=>{row.blur();playSong(song,row);};
  const more=document.createElement('button');more.type='button';more.className='song-more-trigger';more.setAttribute('aria-label',`${song.title}的更多操作`);more.textContent='···';
  more.onclick=e=>{chosenSong=song;showDialog('song-action-dialog',e);$('song-action-name').textContent=`${song.title} · ${song.artist}`;updateMiniVisibility();};
  row.append(number,info,album,length);entry.append(row,more);return entry;
}
function renderSongs(append=false){
  const list=$('song-list');
  if(!append){
    const query=$('search').value.trim().toLocaleLowerCase();
    filtered=query?songs.filter(s=>`${s.title} ${s.artist} ${s.album}`.toLocaleLowerCase().includes(query)):songs;
    $('list-state').textContent=filtered.length?`${query?`找到 ${filtered.length} 首 · `:''}共 ${songs.length} 首歌曲`:query?'没有找到歌曲，试试其他关键词。':'歌单为空，点击“刷新歌单”重试。';
    list.replaceChildren();
  }
  const fragment=document.createDocumentFragment();
  for(const song of filtered.slice(list.childElementCount,visible))fragment.append(createSongRow(song));
  list.append(fragment);
  $('more').hidden=list.childElementCount>=filtered.length;
  if($('quick-search-dialog').open)renderQuickResults();
}
function renderQuickResults(){
  const query=$('quick-search').value.trim().toLocaleLowerCase();
  const matches=query?songs.filter(s=>`${s.title} ${s.artist} ${s.album}`.toLocaleLowerCase().includes(query)):[];
  $('quick-search-state').textContent=query?matches.length?`找到 ${matches.length} 首歌曲`:'没有找到歌曲，试试其他关键词。':'输入歌名、歌手或专辑即可搜索。';
  const fragment=document.createDocumentFragment();
  for(const song of matches)fragment.append(createSongRow(song));
  $('quick-search-results').replaceChildren(fragment);
}
const moreObserver=new IntersectionObserver(([entry])=>{
  if(entry.isIntersecting&&!$('more').hidden&&visible<filtered.length){
    visible=Math.min(visible+60,filtered.length);renderSongs(true);
  }
},{rootMargin:'400px 0px'});
moreObserver.observe($('more'));

async function loadPlaylist(refresh=false){$('refresh').disabled=true;$('list-state').textContent=refresh?'正在刷新歌单…':'正在加载歌单…';try{const data=await api(`/api/playlist${refresh?'?refresh=1':''}`);songs=data.songs;$('song-count').textContent=`${songs.length} 首`;visible=60;renderSongs();$('account-state').hidden=true;if(refresh)toast(`已刷新 ${songs.length} 首歌曲`);}catch(e){$('list-state').textContent=e.message;$('account-state').textContent=`${e.message} ${localLogin?'可点击“重新登录”恢复。':'请在 Mac 本机打开 localhost 重新登录。'}`;$('account-state').hidden=false;toast(e.message);}finally{$('refresh').disabled=false;}}
async function checkSession(){try{const state=await api('/api/qq/session');localLogin=state.local;$('login').hidden=!state.local;$('login').textContent=state.connected?'重新登录':'登录 QQ 音乐';}catch(e){toast(e.message);}}
function stopQr(){clearInterval(qrTimer);qrTimer=null;}
async function startQr(){stopQr();$('qr-state').hidden=false;$('qr-state').textContent='正在获取二维码…';$('qr-image').hidden=true;try{const data=await api('/api/qq/login/qr',{method:'POST'});$('qr-image').src=data.image;$('qr-image').hidden=false;$('qr-state').textContent='请用 QQ 扫码并确认登录';qrTimer=setInterval(pollQr,2500);}catch(e){$('qr-state').textContent=`${e.message}；可尝试导入 Cookie。`;}}
async function pollQr(){try{const data=await api('/api/qq/login/poll');if(data.state==='waiting')return;if(data.state==='scanned'){$('qr-state').textContent='已扫码，请在手机上确认';return;}if(data.state==='expired'){stopQr();$('qr-state').textContent='二维码已过期，请重新获取。';return;}if(data.state==='connected'){stopQr();$('login-dialog').close();await checkSession();await loadPlaylist(true);toast('QQ 音乐已登录');}}catch(e){stopQr();$('qr-state').textContent=e.message;}}
function syncVisualViewport(){
  const view=window.visualViewport;
  document.documentElement.style.setProperty('--visual-height',`${Math.round(view?.height||window.innerHeight)}px`);
  document.documentElement.style.setProperty('--visual-top',`${Math.round(view?.offsetTop||0)}px`);
}
function placeQuickSearch(){
  syncVisualViewport();
  const dialog=$('quick-search-dialog');
  if(dialog.open)dialog.style.top=`calc(var(--visual-top) + 14px)`;
}
function showDialog(id,event){
  const dialog=$(id);dialog.classList.toggle('suppress-initial-focus',!event||event.detail!==0);dialog.showModal();
  if(id==='quick-search-dialog')requestAnimationFrame(placeQuickSearch);
}
const dialogIds=['login-dialog','lyrics-dialog','quick-search-dialog','queue-dialog','sleep-dialog','song-action-dialog','queue-action-dialog','rooms-dialog','utilities-dialog'];
for(const id of dialogIds){
  const dialog=$(id);
  dialog.addEventListener('keydown',()=>dialog.classList.remove('suppress-initial-focus'));
  dialog.addEventListener('close',()=>{dialog.classList.remove('suppress-initial-focus');if(id==='quick-search-dialog')dialog.style.top='';});
  dialog.addEventListener('click',event=>{
    if(event.target!==dialog)return;
    const bounds=dialog.getBoundingClientRect();
    if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();
  });
}
syncVisualViewport();
window.visualViewport?.addEventListener('resize',placeQuickSearch);
window.visualViewport?.addEventListener('scroll',placeQuickSearch);
$('login').onclick=e=>{showDialog('login-dialog',e);updateMiniVisibility();startQr();};$('login-close').onclick=()=>$('login-dialog').close();$('login-dialog').onclose=stopQr;$('qr-retry').onclick=startQr;
$('lyrics-open').onclick=$('mini-lyric-open').onclick=e=>{showDialog('lyrics-dialog',e);updateMiniVisibility();renderLyricsAt(positionAnchor.seconds+(positionAnchor.playing?(Date.now()-positionAnchor.at)/1000:0));scrollActiveLyric();};
$('lyrics-close').onclick=()=>$('lyrics-dialog').close();$('lyrics-dialog').addEventListener('close',updateMiniVisibility);
$('cookie-save').onclick=async()=>{const button=$('cookie-save');button.disabled=true;try{await api('/api/qq/login/cookie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:$('cookie-input').value})});$('cookie-input').value='';$('login-dialog').close();stopQr();await checkSession();await loadPlaylist(true);toast('QQ 音乐登录状态已保存');}catch(e){toast(e.message);}finally{button.disabled=false;}};
async function control(action,value){
  const toggle=action==='repeatAll'?$('repeat-all'):action==='crossfade'?$('crossfade'):null;
  if(toggle)toggle.disabled=true;
  const expected=action==='play'||action==='next'||action==='previous'?true:action==='pause'?false:action==='seek'?Boolean(currentStatus?.playing):null;
  if(action==='seek')beginTransportSync(expected,Number(value));
  else if(expected!==null)beginTransportSync(expected);
  try{
    await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value})});
    if(expected!==null)await settleTransport(expected);else await updateStatus();
  }
  catch(e){expectedPlaying=null;expectedPosition=null;transportSettlingUntil=0;await updateStatus();toast(e.message);}finally{if(toggle)toggle.disabled=false;}
}
async function sendVolume(){if(volumeSending)return;volumeSending=true;try{while(volumeDesired!==null){const value=volumeDesired;volumeDesired=null;await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'volume',value})});}}catch(e){volumeDesired=null;toast(e.message);}finally{volumeSending=false;await updateStatus();}}
function queueVolume(value){volumeDesired=value;sendVolume();}
function bindPlayer(prefix){
  $(prefix+'toggle-play').onclick=event=>{event.currentTarget.blur();control(currentStatus?.playing?'pause':'play');};
  $(prefix+'previous').onclick=event=>{event.currentTarget.blur();control('previous');};$(prefix+'next').onclick=event=>{event.currentTarget.blur();control('next');};
  $(prefix+'shuffle').onclick=()=>control('shuffle',!currentStatus?.shuffle);
  $(prefix+'repeat-one').onclick=()=>control('repeatOne',!currentStatus?.repeatOne);
  $(prefix+'mute').onclick=()=>control('mute',!currentStatus?.mute);
  $(prefix+'volume').addEventListener('pointerdown',()=>{volumeDragging=true;});
  $(prefix+'volume').oninput=e=>{for(const p of ['','mini-']){$(p+'volume').value=e.target.value;$(p+'volume-value').textContent=`${e.target.value}%`;}queueVolume(Number(e.target.value));};
  $(prefix+'volume').onchange=e=>queueVolume(Number(e.target.value));
  $(prefix+'seek').addEventListener('pointerdown',()=>{seeking=true;});
  $(prefix+'seek').oninput=e=>{seeking=true;for(const p of ['','mini-']){$(p+'seek').value=e.target.value;$(p+'position').textContent=duration(Number(e.target.value));}};
  $(prefix+'seek').onchange=async e=>{const value=Number(e.target.value);try{await control('seek',value);}finally{seeking=false;}};
}
bindPlayer('');bindPlayer('mini-');
window.addEventListener('pointerup',()=>{volumeDragging=false;});
function updateMiniVisibility(){const dialogOpen=dialogIds.some(id=>$(id).open);const scrolled=document.querySelector('.player').getBoundingClientRect().bottom<=0;$('mini-player').hidden=dialogOpen||!scrolled;$('floating-actions').hidden=dialogOpen||!scrolled;}
window.addEventListener('scroll',updateMiniVisibility,{passive:true});window.addEventListener('resize',updateMiniVisibility);
$('login-dialog').addEventListener('close',updateMiniVisibility);
updateMiniVisibility();
$('search').oninput=()=>{visible=60;renderSongs();};$('refresh').onclick=()=>loadPlaylist(true);
$('quick-search-open').onclick=e=>{$('quick-search').value=$('search').value;showDialog('quick-search-dialog',e);renderQuickResults();updateMiniVisibility();$('quick-search').focus({preventScroll:true});};
$('quick-search-close').onclick=()=>$('quick-search-dialog').close();
$('quick-search-dialog').addEventListener('close',updateMiniVisibility);
$('quick-search').oninput=renderQuickResults;
$('back-to-top').onclick=()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
$('utilities-open').onclick=event=>{showDialog('utilities-dialog',event);updateMiniVisibility();};
$('utilities-close').onclick=()=>$('utilities-dialog').close();
$('utilities-dialog').addEventListener('close',updateMiniVisibility);
$('repeat-all').onclick=()=>control('repeatAll',!currentStatus?.repeatAll);
$('crossfade').onclick=()=>control('crossfade',!currentStatus?.crossfade);
$('song-action-close').onclick=()=>$('song-action-dialog').close();
$('song-action-dialog').addEventListener('close',updateMiniVisibility);
async function addChosenSong(placement){
  const song=chosenSong;if(!song)return;
  const buttons=$('song-action-dialog').querySelectorAll('button');for(const button of buttons)button.disabled=true;
  try{await api('/api/queue/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mid:song.mid,placement})});$('song-action-dialog').close();toast(`${song.title}已${placement==='next'?'加入下一首':'加入队列末尾'}`);if($('queue-dialog').open)await loadQueue(queueStart);}
  catch(e){toast(e.message);}finally{for(const button of buttons)button.disabled=false;}
}
$('song-play-next').onclick=()=>addChosenSong('next');$('song-add-end').onclick=()=>addChosenSong('end');
let queueLoading=false,queueStart=0;
async function loadQueue(start=0,focusCurrent=false){
  if(queueLoading)return;
  queueLoading=true;$('queue-refresh').disabled=true;$('queue-more').disabled=true;$('queue-prev').disabled=true;
  $('queue-state').textContent='正在读取 Sonos 播放队列…';
  try{
    const data=await api(`/api/queue?start=${start}`);
    start=data.start;
    const fragment=document.createDocumentFragment();
    for(const track of data.tracks){
      const entry=document.createElement('div');entry.className='queue-entry';
      const row=document.createElement('button');row.type='button';row.className='queue-track';row.dataset.number=track.number;
      row.setAttribute('aria-label',`播放队列第 ${track.number} 首：${track.title}，${track.artist}`);
      const number=document.createElement('span');number.className='queue-number';number.textContent=track.number;
      const info=document.createElement('span');info.className='queue-info';
      const title=document.createElement('strong');title.textContent=track.title;
      const artist=document.createElement('small');artist.textContent=track.artist;
      info.append(title,artist);row.append(number,info);
      const more=document.createElement('button');more.type='button';more.className='queue-more-trigger';more.setAttribute('aria-label',`${track.title}的队列操作`);more.textContent='···';
      more.onclick=e=>{chosenQueueTrack=track;$('queue-action-name').textContent=`${track.number}. ${track.title} · ${track.artist}`;$('queue-move-up').disabled=track.number<=1;$('queue-move-down').disabled=track.number>=queueTotal;showDialog('queue-action-dialog',e);updateMiniVisibility();};
      row.onclick=async()=>{row.blur();row.disabled=true;try{await api('/api/queue/play',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:track.number})});beginTransportSync(true);await settleTransport(true);markCurrentQueueTrack();toast(`正在播放：${track.title}`);}catch(e){expectedPlaying=null;expectedPosition=null;transportSettlingUntil=0;await updateStatus();toast(e.message);}finally{row.disabled=false;}};
      entry.append(row,more);fragment.append(entry);
    }
    $('queue-list').replaceChildren(fragment);queueStart=start;queueTotal=data.total;
    $('queue-list').scrollTop=0;
    $('queue-state').textContent=data.total?`第 ${start+1}–${start+data.tracks.length} 首 / 共 ${data.total} 首`:'当前队列为空';
    $('queue-prev').hidden=start===0;
    $('queue-more').hidden=start+data.tracks.length>=data.total;
    markCurrentQueueTrack();
    if(focusCurrent){const list=$('queue-list'),current=list.querySelector('.queue-track.current');if(current)list.scrollTop=current.getBoundingClientRect().top-list.getBoundingClientRect().top+list.scrollTop-list.clientHeight/2;}
  }catch(e){$('queue-state').textContent=e.message;toast(e.message);}
  finally{queueLoading=false;$('queue-refresh').disabled=false;$('queue-more').disabled=false;$('queue-prev').disabled=false;}
}
function markCurrentQueueTrack(){
  for(const row of $('queue-list').querySelectorAll('.queue-track'))row.classList.toggle('current',Number(row.dataset.number)===currentStatus?.track);
}
$('queue-open').onclick=e=>{showDialog('queue-dialog',e);updateMiniVisibility();loadQueue(Math.floor((Math.max(1,currentStatus?.track||1)-1)/100)*100,true);};
$('queue-close').onclick=()=>$('queue-dialog').close();
$('queue-refresh').onclick=()=>loadQueue(queueStart);
$('queue-prev').onclick=()=>loadQueue(Math.max(0,queueStart-100));
$('queue-more').onclick=()=>loadQueue(queueStart+100);
$('queue-dialog').addEventListener('close',updateMiniVisibility);
$('queue-action-close').onclick=()=>$('queue-action-dialog').close();
$('queue-action-dialog').addEventListener('close',updateMiniVisibility);
async function editChosenQueue(action,before){
  const track=chosenQueueTrack;if(!track)return;
  const buttons=$('queue-action-dialog').querySelectorAll('button');for(const button of buttons)button.disabled=true;
  try{await api('/api/queue/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,number:track.number,songId:track.songId,before})});$('queue-action-dialog').close();await loadQueue(queueStart);await updateStatus();toast(action==='remove'?'已移出队列':'已调整队列顺序');}
  catch(e){toast(e.message);}finally{for(const button of buttons)button.disabled=false;}
}
$('queue-move-up').onclick=()=>editChosenQueue('move',chosenQueueTrack.number-1);
$('queue-move-down').onclick=()=>editChosenQueue('move',chosenQueueTrack.number+2);
$('queue-remove').onclick=()=>editChosenQueue('remove');
async function loadRooms(){
  $('rooms-state').textContent='正在读取房间…';
  try{
    roomData=await api('/api/rooms');
    if(!roomData.rooms.some(room=>room.id===selectedRoomId)){selectedRoomId=roomData.defaultId;localStorage.setItem('sonos-room-id',selectedRoomId);}
    const selected=roomData.rooms.find(room=>room.id===selectedRoomId),fragment=document.createDocumentFragment();
    for(const room of roomData.rooms){
      const entry=document.createElement('div');entry.className='room-entry';
      const header=document.createElement('div');header.className='room-row';
      const name=document.createElement('strong');name.textContent=room.name;
      const button=document.createElement('button');button.type='button';button.textContent=room.id===selectedRoomId?'当前房间':'切换到这里';button.disabled=room.id===selectedRoomId;
      button.onclick=async()=>{selectedRoomId=room.id;localStorage.setItem('sonos-room-id',room.id);await updateStatus();await loadSleep();await loadRooms();};
      header.append(name,button);entry.append(header);
      const group=document.createElement('small');group.textContent=room.id===selected.id?'当前控制房间':room.groupId===selected.groupId?`与 ${selected.name} 同组`:'独立播放';entry.append(group);
      if(room.volume!=null){
        const label=document.createElement('label');label.textContent=`${room.name}音量 ${room.volume}%`;
        const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max='100';slider.value=room.volume;slider.setAttribute('aria-label',`${room.name}音量`);
        slider.oninput=()=>{label.textContent=`${room.name}音量 ${slider.value}%`;};
        slider.onchange=async()=>{try{await api(`/api/control?room=${encodeURIComponent(room.id)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'volume',value:Number(slider.value)})});await updateStatus();}catch(e){toast(e.message);}};
        entry.append(label,slider);
      }
      if(room.groupId!==selected.groupId){
        const join=document.createElement('button');join.type='button';join.className='room-group-action';join.textContent=`让 ${room.name} 加入当前分组`;
        join.onclick=()=>changeGroup({action:'join',roomId:room.id,targetId:selected.id});entry.append(join);
      }else if(room.id!==room.coordinatorId){
        const leave=document.createElement('button');leave.type='button';leave.className='room-group-action';leave.textContent=`将 ${room.name} 移出分组`;
        leave.onclick=()=>changeGroup({action:'leave',roomId:room.id});entry.append(leave);
      }
      fragment.append(entry);
    }
    $('rooms-list').replaceChildren(fragment);
    const count=roomData.rooms.filter(room=>room.groupId===selected.groupId).length;
    $('rooms-state').textContent=roomData.rooms.length===1?'目前只发现一个房间。':`发现 ${roomData.rooms.length} 个房间 · 当前分组 ${count} 个房间`;
    $('group-controls').hidden=count<2;
  }catch(e){$('rooms-state').textContent=e.message;toast(e.message);}
}
async function changeGroup(input){
  try{await api('/api/rooms/group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});await loadRooms();await updateStatus();toast('房间分组已更新');}
  catch(e){toast(e.message);}
}
$('rooms-open').onclick=e=>{$('utilities-dialog').close();showDialog('rooms-dialog',e);updateMiniVisibility();loadRooms();};
$('rooms-close').onclick=()=>$('rooms-dialog').close();
$('rooms-dialog').addEventListener('close',updateMiniVisibility);
let groupDesired=null,groupSending=false;
async function sendGroupVolume(){
  if(groupSending)return;groupSending=true;
  try{while(groupDesired!==null){const value=groupDesired;groupDesired=null;await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'groupVolume',value})});}}
  catch(e){groupDesired=null;toast(e.message);}finally{groupSending=false;await updateStatus();}
}
$('group-volume').oninput=e=>{$('group-volume-value').textContent=`${e.target.value}%`;groupDesired=Number(e.target.value);sendGroupVolume();};
let sleepEndsAt=null;
function renderSleep(){
  const remaining=sleepEndsAt?Math.max(0,Math.ceil((sleepEndsAt-Date.now())/1000)):0;
  if(!remaining)sleepEndsAt=null;
  const deadline=remaining?new Date(Math.ceil(sleepEndsAt/60000)*60000):null;
  const day=deadline&&deadline.toDateString()!==new Date().toDateString()?'明天 ':'';
  $('sleep-state').textContent=remaining?`将在 ${day}${deadline.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} 停止 · 剩余 ${Math.floor(remaining/60)} 分 ${remaining%60} 秒`:'当前没有设置睡眠定时';
  $('sleep-badge').textContent=remaining?` · ${Math.ceil(remaining/60)} 分`:'';
  $('sleep-badge').hidden=!remaining;$('sleep-cancel').hidden=!remaining;
}
async function loadSleep(){
  $('sleep-state').textContent='正在读取定时状态…';
  try{const data=await api('/api/sleep');sleepEndsAt=data.endsAt?Date.parse(data.endsAt):null;renderSleep();}
  catch(e){$('sleep-state').textContent=e.message;toast(e.message);}
}
async function setSleep(input){
  const buttons=$('sleep-dialog').querySelectorAll('button');for(const button of buttons)button.disabled=true;
  try{const data=await api('/api/sleep',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});sleepEndsAt=data.endsAt?Date.parse(data.endsAt):null;renderSleep();toast(input.mode==='cancel'?'已取消睡眠定时':'睡眠定时已设置');}
  catch(e){toast(e.message);}
  finally{for(const button of buttons)button.disabled=false;}
}
$('sleep-open').onclick=e=>{$('utilities-dialog').close();showDialog('sleep-dialog',e);updateMiniVisibility();loadSleep();};
$('sleep-close').onclick=()=>$('sleep-dialog').close();
$('sleep-dialog').addEventListener('close',updateMiniVisibility);
$('sleep-form').noValidate=true;
$('sleep-time').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('sleep-form button[value="until"]').click();}});
$('sleep-form').onsubmit=e=>{
  e.preventDefault();
  if(e.submitter?.value==='minutes')return setSleep({mode:'minutes',minutes:Number($('sleep-minutes').value)});
  const value=$('sleep-time').value;
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)){toast('请选择停止时间');return;}
  const [hours,minutes]=value.split(':').map(Number),target=new Date();
  target.setHours(hours,minutes,0,0);
  if(target<=new Date())target.setDate(target.getDate()+1);
  setSleep({mode:'until',at:target.toISOString()});
};
$('sleep-cancel').onclick=()=>setSleep({mode:'cancel'});
checkSession().then(()=>loadPlaylist());loadRooms().then(()=>{updateStatus();loadSleep();});setInterval(updateStatus,5000);setInterval(()=>{if(!document.hidden)loadSleep();},60000);
setInterval(()=>{updateProgress();renderSleep();},1000);
