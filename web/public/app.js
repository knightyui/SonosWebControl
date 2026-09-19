const $=id=>document.getElementById(id);
let songs=[],visible=60,filtered=[],currentStatus=null,toastTimer,qrTimer,localLogin=false;
let seeking=false,volumeDragging=false,volumeDesired=null,volumeSending=false,artUrl='';
let lyrics=[],lyricTrack='',lyricMessage='正在读取歌词…',activeLyricIndex=-2;
let positionAnchor={seconds:0,at:Date.now(),playing:false};
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
async function api(path,options){const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw Error(data.error||`请求失败：${response.status}`);return data;}
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
  positionAnchor={seconds:timecode(s.position),at:Date.now(),playing:s.playing};
  const length=timecode(s.duration);
  for(const prefix of ['','mini-']){
    const play=$(prefix+'toggle-play'),shuffle=$(prefix+'shuffle'),mute=$(prefix+'mute');
    play.classList.toggle('playing',s.playing);play.setAttribute('aria-label',s.playing?'暂停':'播放');
    shuffle.classList.toggle('active',s.shuffle);shuffle.setAttribute('aria-pressed',String(s.shuffle));shuffle.title=s.shuffle?'关闭随机播放':'随机播放';
    mute.classList.toggle('active',s.mute);mute.setAttribute('aria-pressed',String(s.mute));mute.setAttribute('aria-label',s.mute?'取消静音':'静音');mute.title=s.mute?'取消静音':'静音';
    if(!volumeDragging&&!volumeSending){$(prefix+'volume').value=s.volume;$(prefix+'volume-value').textContent=`${s.volume}%`;}
    const seek=$(prefix+'seek');seek.disabled=!length;seek.max=Math.max(1,length);
    if(!seeking){seek.value=Math.min(length,timecode(s.position));$(prefix+'position').textContent=s.position||'0:00';}
    $(prefix+'duration').textContent=s.duration||'0:00';
  }
  if(artUrl!==(s.albumArt||'')){artUrl=s.albumArt||'';resetSongTheme();for(const id of ['album-art','mini-art']){const image=$(id);image.hidden=true;image.removeAttribute('src');if(artUrl)image.src=artUrl;}}
  loadLyricsFor(s);
  renderLyricsAt(positionAnchor.seconds);
}
for(const id of ['album-art','mini-art']){const art=$(id);art.onload=()=>{art.hidden=false;if(id==='album-art')applySongTheme(art);};art.onerror=()=>{art.hidden=true;if(id==='album-art')resetSongTheme();};}
async function updateStatus(){try{renderStatus(await api('/api/status'));}catch(e){$('connection').textContent='● 音响未连接';$('connection').className='connection error';if(!currentStatus)toast(e.message);}}
async function playSong(song,row){
  const fromSearch=Boolean(row.closest('#quick-search-results'));
  row.disabled=true;row.classList.add('loading');
  try{
    await api('/api/play',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mid:song.mid})});
    toast(`正在播放：${song.title}`);await updateStatus();
    if(fromSearch)$('quick-search-state').textContent=`正在播放：${song.title}`;
  }catch(e){toast(e.message);if(fromSearch)$('quick-search-state').textContent=e.message;}
  finally{row.disabled=false;row.classList.remove('loading');}
}
function createSongRow(song){
  const row=document.createElement('button');row.type='button';row.className='song';
  row.setAttribute('aria-label',`播放 ${song.title}，${song.artist}`);
  const number=document.createElement('span');number.className='song-index';number.textContent=song.index;
  const info=document.createElement('span');info.className='song-info';
  const name=document.createElement('span');name.className='song-name';name.textContent=song.title;
  const artist=document.createElement('span');artist.className='song-sub';artist.textContent=song.artist;
  info.append(name,artist);
  const album=document.createElement('span');album.className='song-album';album.textContent=song.album;
  const length=document.createElement('span');length.className='song-duration';length.textContent=duration(song.duration);
  row.onclick=()=>playSong(song,row);
  row.append(number,info,album,length);return row;
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
function showDialog(id,event){const dialog=$(id);dialog.classList.toggle('suppress-initial-focus',event.detail>0);dialog.showModal();}
for(const id of ['login-dialog','lyrics-dialog','quick-search-dialog']){const dialog=$(id);dialog.addEventListener('keydown',()=>dialog.classList.remove('suppress-initial-focus'));dialog.addEventListener('close',()=>dialog.classList.remove('suppress-initial-focus'));}
$('login').onclick=e=>{showDialog('login-dialog',e);updateMiniVisibility();startQr();};$('login-close').onclick=()=>$('login-dialog').close();$('login-dialog').onclose=stopQr;$('qr-retry').onclick=startQr;
$('lyrics-open').onclick=$('mini-lyric-open').onclick=e=>{showDialog('lyrics-dialog',e);updateMiniVisibility();renderLyricsAt(positionAnchor.seconds+(positionAnchor.playing?(Date.now()-positionAnchor.at)/1000:0));scrollActiveLyric();};
$('lyrics-close').onclick=()=>$('lyrics-dialog').close();$('lyrics-dialog').addEventListener('close',updateMiniVisibility);
$('cookie-save').onclick=async()=>{const button=$('cookie-save');button.disabled=true;try{await api('/api/qq/login/cookie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:$('cookie-input').value})});$('cookie-input').value='';$('login-dialog').close();stopQr();await checkSession();await loadPlaylist(true);toast('QQ 音乐登录状态已保存');}catch(e){toast(e.message);}finally{button.disabled=false;}};
async function control(action,value){try{await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value})});await updateStatus();}catch(e){toast(e.message);}}
async function sendVolume(){if(volumeSending)return;volumeSending=true;try{while(volumeDesired!==null){const value=volumeDesired;volumeDesired=null;await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'volume',value})});}}catch(e){volumeDesired=null;toast(e.message);}finally{volumeSending=false;await updateStatus();}}
function queueVolume(value){volumeDesired=value;sendVolume();}
function bindPlayer(prefix){
  $(prefix+'toggle-play').onclick=()=>control(currentStatus?.playing?'pause':'play');
  $(prefix+'previous').onclick=()=>control('previous');$(prefix+'next').onclick=()=>control('next');
  $(prefix+'shuffle').onclick=()=>control('shuffle',!currentStatus?.shuffle);
  $(prefix+'mute').onclick=()=>control('mute',!currentStatus?.mute);
  $(prefix+'volume').addEventListener('pointerdown',()=>{volumeDragging=true;});
  $(prefix+'volume').oninput=e=>{for(const p of ['','mini-']){$(p+'volume').value=e.target.value;$(p+'volume-value').textContent=`${e.target.value}%`;}queueVolume(Number(e.target.value));};
  $(prefix+'volume').onchange=e=>queueVolume(Number(e.target.value));
  $(prefix+'seek').addEventListener('pointerdown',()=>{seeking=true;});
  $(prefix+'seek').oninput=e=>{seeking=true;for(const p of ['','mini-']){$(p+'seek').value=e.target.value;$(p+'position').textContent=duration(Number(e.target.value));}};
  $(prefix+'seek').onchange=async e=>{const value=Number(e.target.value);try{await control('seek',value);}finally{seeking=false;await updateStatus();}};
}
bindPlayer('');bindPlayer('mini-');
window.addEventListener('pointerup',()=>{volumeDragging=false;});
function updateMiniVisibility(){const dialogOpen=$('login-dialog').open||$('lyrics-dialog').open||$('quick-search-dialog').open;const scrolled=document.querySelector('.player').getBoundingClientRect().bottom<=0;$('mini-player').hidden=dialogOpen||!scrolled;$('floating-actions').hidden=dialogOpen||!scrolled;}
window.addEventListener('scroll',updateMiniVisibility,{passive:true});window.addEventListener('resize',updateMiniVisibility);
$('login-dialog').addEventListener('close',updateMiniVisibility);
updateMiniVisibility();
$('search').oninput=()=>{visible=60;renderSongs();};$('refresh').onclick=()=>loadPlaylist(true);
$('quick-search-open').onclick=e=>{$('quick-search').value=$('search').value;showDialog('quick-search-dialog',e);renderQuickResults();updateMiniVisibility();$('quick-search').focus({preventScroll:true});};
$('quick-search-close').onclick=()=>$('quick-search-dialog').close();
$('quick-search-dialog').addEventListener('close',updateMiniVisibility);
$('quick-search').oninput=renderQuickResults;
$('back-to-top').onclick=()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
checkSession().then(()=>loadPlaylist());updateStatus();setInterval(updateStatus,5000);
setInterval(()=>{if(!currentStatus)return;renderLyricsAt(positionAnchor.seconds+(positionAnchor.playing?(Date.now()-positionAnchor.at)/1000:0));},500);
