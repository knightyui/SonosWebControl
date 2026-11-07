import {assessTransport,createOperationTracker} from './transport-sync.mjs';
import {currentPlaylistIndex,visibleCountForIndex} from './library-navigation.mjs';
import {createPlaylistCache,createQueryCache,createLibraryViewStore} from './playlist-cache.mjs';
import {bindBackdropDismiss,bindDialogEditing} from './dialog-interactions.mjs';
const $=id=>document.getElementById(id);
let songs=[],visible=60,filtered=[],playlistOptions=[],currentStatus=null,toastTimer,qrTimer,localLogin=false;
function savedRoom(){try{return localStorage.getItem('sonos-room-id')||'';}catch{return '';}}
let roomGeneration=0;
let selectedRoomId=savedRoom(),roomData=null,chosenSong=null,chosenQueueTrack=null,queueTotal=0;
const playlistCache=createPlaylistCache({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)});
let libraryAccount='',libraryPlaylistId='',libraryReady=false,playlistRequest=0,displayedPlaylistId='';
const queryCache=createQueryCache();
const libraryViews=createLibraryViewStore({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)});
let libraryRestore=null,restoringLibrary=false,browseSaveTimer;
let songActionGeneration=0,queueActionGeneration=0;
let lastStatusAt=0,statusFailed=false;
let seeking=false,volumeDragging=false,volumeDesired=null,volumeSending=false,artUrl='';
let lyrics=[],lyricTrack='',lyricMessage='正在读取歌词…',activeLyricIndex=-2;
let positionAnchor={seconds:0,at:Date.now(),playing:false};
let statusRequest=0,transportSettlingUntil=0,expectedPlaying=null,statusInFlight=null;
let transportExpectation=null;
const transportOperations=createOperationTracker();
let playRequestGeneration=0;
let pendingShuffleValue=null,shuffleGeneration=0;
const pendingModes=new Map();let modeGeneration=0;
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
  if(selectedRoomId&&!url.searchParams.has('room')&&(/^\/api\/(status|control|queue|sleep|play|history\/record)(?:\/|$)/).test(url.pathname))url.searchParams.set('room',selectedRoomId);
  const writing=options?.method&&options.method!=='GET';
  try{
    const response=await fetch(url,{...options,signal:options?.signal||AbortSignal.timeout(writing?90000:30000)});
    let data;try{data=await response.json();}catch{throw Error(`服务响应无效（HTTP ${response.status}），请重试。`);}
    if(!response.ok)throw Error(data.error||`请求失败：${response.status}`);
    return data;
  }catch(error){
    if(error.name==='TimeoutError')throw Error(writing?'请求超时，操作可能已到达音箱，请先检查当前状态。':'请求超时，请检查网络后重试。');
    throw error;
  }
}
function paintRange(slider){const max=Number(slider.max)||1;slider.style.setProperty('--range-fill',`${Math.max(0,Math.min(100,Number(slider.value)/max*100))}%`);}
function duration(seconds){return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function timecode(value){const p=String(value||'0:00').split(':').map(Number);return p.length===3?p[0]*3600+p[1]*60+p[2]:p.length===2?p[0]*60+p[1]:0;}
function renderLyricList(){
  const list=$('lyrics-list');
  if(!lyrics.length){list.textContent=lyricMessage;return;}
  const fragment=document.createDocumentFragment();
  for(const line of lyrics){
    const row=document.createElement('div');row.className='lyric-line';
    if(line.translation){
      const original=document.createElement('span');original.className='lyric-original';original.textContent=line.text;
      const translated=document.createElement('span');translated.className='lyric-translation';translated.textContent=line.translation;
      row.append(original,translated);
    }else row.textContent=line.text;
    fragment.append(row);
  }
  list.replaceChildren(fragment);
  activeLyricIndex=-2;
}
function scrollActiveLyric(){
  const list=$('lyrics-list'),active=list.querySelector('.lyric-line.active');
  if(active)list.scrollTo({top:active.offsetTop-list.clientHeight/2+active.offsetHeight/2,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
function renderLyricsAt(seconds){
  if(!lyrics.length){$('lyric-current').textContent=lyricMessage;$('lyric-next').textContent='';$('lyrics-open').classList.remove('has-translation');$('mini-lyric-open').textContent=lyricMessage;return;}
  let index=-1;
  for(let i=0;i<lyrics.length&&lyrics[i].time<=seconds;i++)index=i;
  const current=index<0?'即将开始':lyrics[index].text;
  const translation=index>=0?lyrics[index].translation||'':'';
  $('lyric-current').textContent=current;$('lyric-next').textContent=translation||lyrics[index+1]?.text||'';
  $('lyrics-open').classList.toggle('has-translation',Boolean(translation));
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
  $('room').textContent=s.room;$('player-room-name').textContent=s.room;$('model').textContent=s.model;
  $('track-title').textContent=s.title||(s.playing?'正在播放':'暂无播放曲目');$('track-artist').textContent=s.artist||'从下方歌单选择歌曲';
  $('mini-title').textContent=s.title||(s.playing?'正在播放':'暂无播放曲目');$('mini-artist').textContent=s.artist||s.room;
  $('lyrics-title').textContent=s.title||'歌词';$('lyrics-artist').textContent=s.artist||'';
  $('room-menu-name').textContent=s.room;$('queue-room-name').textContent=s.room;$('utility-track').textContent=s.title||(s.playing?'正在播放':'暂无播放曲目');$('utility-artist').textContent=s.artist||'QQ 音乐';
  for(const [id,value] of [['repeat-all',s.repeatAll],['crossfade',s.crossfade]]){$(id).classList.toggle('active',Boolean(value));$(id).setAttribute('aria-pressed',String(Boolean(value)));}
  $('group-controls').hidden=s.groupSize<2;
  if(s.groupSize>1&&!groupSending&&!volumeDragging){$('group-volume').value=s.groupVolume;paintRange($('group-volume'));$('group-volume-value').textContent=`${s.groupVolume}%`;}
  positionAnchor={seconds:timecode(s.position),at:Date.now(),playing:s.playing};
  const length=timecode(s.duration);
  for(const prefix of ['','mini-']){
    const play=$(prefix+'toggle-play'),shuffle=$(prefix+'shuffle'),repeat=$(prefix+'repeat-one'),mute=$(prefix+'mute');
    play.classList.toggle('playing',s.playing);play.setAttribute('aria-label',s.playing?'暂停':'播放');
    shuffle.classList.toggle('active',s.shuffle);shuffle.setAttribute('aria-pressed',String(s.shuffle));shuffle.title=s.shuffle?'关闭随机播放':'随机播放';
    repeat.classList.toggle('active',s.repeatOne);repeat.setAttribute('aria-pressed',String(Boolean(s.repeatOne)));repeat.title=s.repeatOne?'关闭单曲循环':'开启单曲循环';
    mute.classList.toggle('active',s.mute);mute.setAttribute('aria-pressed',String(s.mute));mute.setAttribute('aria-label',s.mute?'取消静音':'静音');mute.title=s.mute?'取消静音':'静音';
    if(!volumeDragging&&!volumeSending){$(prefix+'volume').value=s.volume;paintRange($(prefix+'volume'));$(prefix+'volume-value').textContent=`${s.volume}%`;}
    const seek=$(prefix+'seek');seek.disabled=!length;seek.max=Math.max(1,length);
    if(!seeking){seek.value=Math.min(length,timecode(s.position));paintRange(seek);$(prefix+'position').textContent=duration(timecode(s.position));}
    $(prefix+'duration').textContent=duration(length);
  }
  $('queue-toggle-play').classList.toggle('playing',s.playing);$('queue-toggle-play').setAttribute('aria-label',s.playing?'暂停':'播放');
  for(const [id,value] of [['queue-shuffle',s.shuffle],['queue-repeat-one',s.repeatOne]]){$(id).classList.toggle('active',Boolean(value));$(id).setAttribute('aria-pressed',String(Boolean(value)));}
  if(!volumeDragging&&!volumeSending){$('queue-volume').value=s.volume;paintRange($('queue-volume'));$('queue-volume-value').textContent=`${s.volume}%`;}
  $('utility-art').hidden=!s.albumArt;$('utility-art').src=s.albumArt||'';
  if(artUrl!==(s.albumArt||'')){artUrl=s.albumArt||'';resetSongTheme();for(const id of ['album-art','mini-art','lyrics-cover','lyrics-backdrop']){const image=$(id);image.hidden=true;image.removeAttribute('src');if(artUrl)image.src=artUrl;}}
  loadLyricsFor(s);
  renderLyricsAt(positionAnchor.seconds);
  markCurrentPlaylistSong();
  if($('queue-dialog').open)markCurrentQueueTrack();
  renderConnectionFeedback(s);
}
function renderConnectionFeedback(s=currentStatus){
  const stale=lastStatusAt&&Date.now()-lastStatusAt>15000;
  const label=statusFailed?'连接中断':expectedPlaying!==null?'正在确认':stale?'正在重连':'已连接';
  $('connection').textContent=`● ${s?.room||'音响'} · ${label}`;
  $('connection').className=`connection ${statusFailed?'error':stale||expectedPlaying!==null?'':'ok'}`;
  $('connection').title=statusFailed||stale?'显示上次状态，恢复连接后自动更新':'选择 Sonos 房间';
  for(const id of ['player-room-name','queue-room-name'])$(id).textContent=s?.room?`${s.room}${label==='已连接'?'':` · ${label}`}`:label;
  if(s)$('mini-artist').textContent=`${s.artist||s.room||''}${label==='已连接'?'':` · ${label}`}`;
  for(const id of ['toggle-play','mini-toggle-play','queue-toggle-play'])$(id).setAttribute('aria-busy',String(expectedPlaying!==null));
}
function updateProgress(){
  if(!currentStatus)return;
  const length=timecode(currentStatus.duration);
  const seconds=livePosition();
  renderConnectionFeedback();
  if(!seeking){
    for(const prefix of ['','mini-']){
      $(prefix+'position').textContent=duration(Math.floor(seconds));
      if(length){$(prefix+'seek').value=Math.floor(seconds);paintRange($(prefix+'seek'));}
    }
  }
  renderLyricsAt(seconds);
}
for(const id of ['album-art','mini-art','lyrics-cover','lyrics-backdrop']){const art=$(id);art.onload=()=>{art.hidden=false;if(id==='album-art')applySongTheme(art);};art.onerror=()=>{art.hidden=true;if(id==='album-art')resetSongTheme();};}
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function livePosition(){
  if(!currentStatus)return 0;
  const length=timecode(currentStatus.duration);
  return Math.min(length||Infinity,positionAnchor.seconds+(positionAnchor.playing?Math.max(0,(Math.min(Date.now(),lastStatusAt?lastStatusAt+15000:Date.now())-positionAnchor.at)/1000):0));
}
function renderOptimisticTransport(playing,position=livePosition()){
  if(!currentStatus)return;
  renderStatus({...currentStatus,playing,position:duration(Math.floor(position))});
}
function beginTransportSync(playing,position,requireTrackChange=false){
  const operation=transportOperations.begin();
  statusRequest++;
  transportExpectation={playing,position:Number.isFinite(position)?position:null,startedAt:Date.now(),requireTrackChange,
    previousTrack:currentStatus?.track,previousSongId:currentStatus?.songId,previousPosition:timecode(currentStatus?.position)};
  expectedPlaying=playing;
  transportSettlingUntil=Date.now()+6500;
  renderOptimisticTransport(playing,position);
  return operation;
}
async function updateStatus(){
  if(statusInFlight?.room===roomGeneration&&statusInFlight.request===statusRequest)return statusInFlight.promise;
  const request=++statusRequest,room=roomGeneration;
  const pending=(async()=>{
  try{
    const status=await api('/api/status');
    if(request!==statusRequest||room!==roomGeneration)return null;
    lastStatusAt=Date.now();statusFailed=false;
    for(const [key,pending] of pendingModes)if(pending.acknowledged&&status[key]===pending.value||Date.now()>pending.expires)pendingModes.delete(key);
    const displayStatus={...status,...Object.fromEntries([...pendingModes].map(([key,pending])=>[key,pending.value])),...(pendingShuffleValue===null?{}:{shuffle:pendingShuffleValue})};
    const awaitingExpectedState=expectedPlaying!==null&&transportSettlingUntil>Date.now();
    const assessment=awaitingExpectedState&&transportExpectation?assessTransport(status,transportExpectation):null;
    if(assessment&&!assessment.confirmed){
      // Sonos briefly reports the previous transport state while applying a command.
      renderStatus({...displayStatus,playing:expectedPlaying,position:assessment.displayPosition===null?status.position:duration(assessment.displayPosition)});
      return null;
    }
    renderStatus(displayStatus);
    return status;
  }catch(e){
    if(request!==statusRequest||room!==roomGeneration)return null;
    const firstFailure=!statusFailed;
    positionAnchor={seconds:livePosition(),at:Date.now(),playing:false};statusFailed=true;renderConnectionFeedback();if(currentStatus)updateProgress();
    if(!currentStatus&&firstFailure)toast(e.message);
    return null;
  }
  })();
  const current={request,room,promise:pending};statusInFlight=current;
  try{return await pending;}finally{if(statusInFlight===current)statusInFlight=null;}
}
async function settleTransport(playing,songId=0,operation){
  const deadline=Date.now()+6500;
  let matchingReports=0;
  while(Date.now()<deadline){
    if(operation&&!transportOperations.isCurrent(operation))return false;
    const status=await updateStatus();
    if(operation&&!transportOperations.isCurrent(operation))return false;
    if(status?.playing===playing&&(!songId||status.songId===songId)){
      matchingReports++;
      if(matchingReports>=2){expectedPlaying=null;transportExpectation=null;transportSettlingUntil=0;renderConnectionFeedback();return true;}
    }else matchingReports=0;
    await delay(350);
  }
  if(operation&&!transportOperations.isCurrent(operation))return false;
  const expectation=transportExpectation;
  expectedPlaying=null;transportExpectation=null;transportSettlingUntil=0;
  const status=await updateStatus();
  return Boolean(status&&status.playing===playing&&(!songId||status.songId===songId)&&
    (!expectation||assessTransport(status,expectation).confirmed));
}
async function playSong(song,row){
  const playRequest=++playRequestGeneration,room=roomGeneration;
  const inSearch=Boolean(row.closest('#quick-search-results'));
  const inHistory=Boolean(row.closest('#history-list'));
  const fromSearch=inSearch||inHistory;
  row.disabled=true;row.classList.add('loading');
  try{
    const endpoint=fromSearch?'/api/play':'/api/play/playlist';
    const payload=fromSearch?{mid:song.mid}:{mid:song.mid,index:song.index,playlistId:$('qq-playlist').value};
    if(!fromSearch)lastQueueImportError='';
    const result=await api(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(playRequest!==playRequestGeneration||room!==roomGeneration)return;
    if(result.import)renderQueueImport(result.import);
    const operation=beginTransportSync(true);
    if(!await settleTransport(true,song.id,operation)){
      if(!transportOperations.isCurrent(operation))return;
      throw Error('Sonos 未能播放这首歌。请检查音箱上的 QQ 音乐账号、会员权限或版权限制。');
    }
    try{await api('/api/history/record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mid:song.mid})});}catch{/* 播放成功不依赖本地历史写入。 */}
    if(inSearch)$('quick-search-state').textContent=`正在播放：${song.title}`;
    if(!$('history-panel').hidden)await loadHistory();
  }catch(e){if(playRequest===playRequestGeneration&&room===roomGeneration){toast(e.message);if(inSearch)$('quick-search-state').textContent=e.message;}}
  finally{row.disabled=false;row.classList.remove('loading');}
}
let queueImportPolling=false,queueImportTimer=null,lastQueueImportError='';
function scheduleQueueImportPoll(){
  if(queueImportTimer)return;
  queueImportTimer=setTimeout(()=>{queueImportTimer=null;pollQueueImport();},1500);
}
function renderQueueImport(job){
  if(!job)return;
  if(['preparing','building'].includes(job.phase))scheduleQueueImportPoll();
  if(job.phase==='error'){
    const message=`歌单导入未完成：${job.error||`已导入 ${job.added}/${job.total} 首`}`;
    if(message!==lastQueueImportError){lastQueueImportError=message;toast(message);}
  }
}
async function pollQueueImport(){
  if(document.hidden||queueImportPolling?.room===roomGeneration)return;
  const pending={room:roomGeneration};queueImportPolling=pending;
  try{const data=await api('/api/queue/import');if(pending.room===roomGeneration)renderQueueImport(data.import);}
  catch{ /* Sonos 暂时离线时，等待下一次可见状态刷新。 */ }
  finally{if(queueImportPolling===pending)queueImportPolling=false;}
}
function createSongRow(song,asListItem=false){
  const entry=document.createElement('div');entry.className='song-entry';
  if(asListItem)entry.setAttribute('role','listitem');
  const row=document.createElement('button');row.type='button';row.className='song';
  row.dataset.songId=song.id;
  if(Number.isInteger(song.index))row.dataset.index=song.index;
  row.setAttribute('aria-label',`播放 ${song.title}，${song.artist}`);
  const number=document.createElement('span');number.className='song-index';number.textContent=song.index;
  if(/^[A-Za-z0-9]{14}$/.test(song.albumMid||'')){
    number.classList.add('song-index-art');
    const cover=document.createElement('img');cover.src=`/api/qq/art?mid=${encodeURIComponent(song.albumMid)}`;cover.alt='';cover.loading='lazy';cover.decoding='async';
    cover.onerror=()=>{cover.remove();number.classList.remove('song-index-art');};
    number.textContent='';number.append(cover);
  }
  const info=document.createElement('span');info.className='song-info';
  const name=document.createElement('span');name.className='song-name';name.textContent=song.title;
  const artist=document.createElement('span');artist.className='song-sub';artist.textContent=song.playedAt?`${song.artist} · ${new Date(song.playedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:song.artist;
  info.append(name,artist);
  const album=document.createElement('span');album.className='song-album';album.textContent=song.album;
  const length=document.createElement('span');length.className='song-duration';length.textContent=duration(song.duration);
  row.onclick=()=>{row.blur();playSong(song,row);};
  const more=document.createElement('button');more.type='button';more.className='song-more-trigger';more.setAttribute('aria-label',`${song.title}的更多操作`);more.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
  more.onclick=e=>{songActionGeneration++;for(const button of $('song-action-dialog').querySelectorAll('button'))button.disabled=false;chosenSong=song;showDialog('song-action-dialog',e);$('song-action-name').textContent=`${song.title} · ${song.artist}`;updateMiniVisibility();};
  row.append(number,info,album,length);entry.append(row,more);return entry;
}
function renderSongs(append=false){
  const list=$('song-list');
  if(!append){
    const query=$('search').value.trim().toLocaleLowerCase();
    filtered=query?songs.filter(s=>`${s.title} ${s.artist} ${s.album}`.toLocaleLowerCase().includes(query)):songs;
    $('list-state').textContent=filtered.length?`${query?`找到 ${filtered.length} 首 · `:''}共 ${songs.length} 首歌曲`:query?'没有找到歌曲，试试其他关键词。':!libraryAccount?'登录 QQ 音乐后查看歌单':!displayedPlaylistId?'正在加载歌单…':'当前歌单没有歌曲，可切换其他歌单。';
    list.replaceChildren();
  }
  const fragment=document.createDocumentFragment();
  for(const song of filtered.slice(list.childElementCount,visible)){
    const entry=createSongRow(song,true);
    if(!libraryReady)for(const button of entry.querySelectorAll('button')){button.disabled=true;button.dataset.libraryPending='true';}
    fragment.append(entry);
  }
  list.append(fragment);
  $('more').hidden=list.childElementCount>=filtered.length;
  markCurrentPlaylistSong();
}
function markCurrentPlaylistSong(){
  const index=currentPlaylistIndex(songs,currentStatus?.songId);
  $('locate-playing').hidden=index<0||!$('history-panel').hidden;
  if(index>=0)$('locate-playing').setAttribute('aria-label',`定位正在播放：${songs[index].title}`);
  for(const row of $('song-list').querySelectorAll('.song')){
    const active=index>=0&&Number(row.dataset.index)===songs[index].index;
    row.classList.toggle('now-playing',active);
    if(active)row.setAttribute('aria-current','true');else row.removeAttribute('aria-current');
  }
}
let locateGeneration=0;
function locatePlayingSong(){
  const index=currentPlaylistIndex(songs,currentStatus?.songId);
  if(index<0)return;
  const generation=++locateGeneration;
  $('search').value='';visible=60;renderSongs();
  const target=visibleCountForIndex(index,songs.length);
  const reveal=()=>{
    if(generation!==locateGeneration)return;
    const row=$('song-list').querySelector(`.song[data-index="${songs[index].index}"]`);
    row?.scrollIntoView({behavior:'smooth',block:'center'});
    $('list-state').textContent=`已定位：${songs[index].title} · 第 ${index+1} 首`;
  };
  const append=()=>{
    if(generation!==locateGeneration)return;
    if(visible<target){visible=Math.min(target,visible+240);renderSongs(true);requestAnimationFrame(append);}
    else reveal();
  };
  requestAnimationFrame(append);
}
$('locate-playing').onclick=locatePlayingSong;
let quickSearchRequest=0,quickSearchTimer,quickSearchPage=0,quickSearchLoading=false,quickSearchInitialized=false,quickSearchMoreFailed=false,quickSearchComposing=false,playlistSearchComposing=false;
function appendQuickResults(matches){
  const fragment=document.createDocumentFragment();
  for(const song of matches)fragment.append(createSongRow(song));
  $('quick-search-results').insertBefore(fragment,$('quick-search-more'));
}
async function renderQuickResults(){
  quickSearchInitialized=true;
  $('quick-search-retry').hidden=true;
  $('quick-search-clear').hidden=!$('quick-search').value;
  const request=++quickSearchRequest,account=libraryAccount;
  const query=$('quick-search').value.trim().toLocaleLowerCase();
  quickSearchPage=0;
  quickSearchMoreFailed=false;quickSearchLoading=false;
  $('quick-search-results').replaceChildren($('quick-search-more'));
  $('quick-search-more').hidden=true;
  $('quick-search-more').disabled=false;
  $('quick-search-more').textContent='加载更多歌曲';
  $('quick-search-results').setAttribute('aria-busy',String(query.length>=2));
  if(query.length>=2){
    $('quick-search-state').textContent='正在搜索 QQ 音乐…';
    try{
      const data=await queryCache.load(account,query,1,()=>api(`/api/search?q=${encodeURIComponent(query)}&page=1`));
      if(request!==quickSearchRequest||account!==libraryAccount)return;
      appendQuickResults(data.songs);
      quickSearchPage=1;
      $('quick-search-more').hidden=!data.hasMore;
      $('quick-search-state').textContent=data.songs.length?`已显示 ${data.songs.length}${data.total?` / 共 ${data.total}`:''} 首`:'没有找到歌曲，试试其他关键词。';
    }
    catch(e){if(request!==quickSearchRequest||account!==libraryAccount)return;$('quick-search-state').textContent=`搜索暂不可用：${e.message}`;$('quick-search-retry').hidden=false;}
    finally{if(request===quickSearchRequest&&account===libraryAccount)$('quick-search-results').setAttribute('aria-busy','false');}
  }else{
    $('quick-search-state').textContent=query?'至少输入两个字再搜索。':'输入歌名、歌手或专辑，搜索 QQ 音乐全曲库。';
  }
}
async function loadMoreQuickResults(){
  if(quickSearchLoading||quickSearchPage<1||$('quick-search-more').disabled)return;
  const request=quickSearchRequest,account=libraryAccount,query=$('quick-search').value.trim().toLocaleLowerCase();
  quickSearchLoading=true;
  const button=$('quick-search-more');button.disabled=true;button.textContent='正在加载…';
  try{
    const page=quickSearchPage+1;
    const data=await queryCache.load(account,query,page,()=>api(`/api/search?q=${encodeURIComponent(query)}&page=${page}`));
    if(request!==quickSearchRequest||account!==libraryAccount)return;
    quickSearchMoreFailed=false;appendQuickResults(data.songs);
    quickSearchPage=data.page;
    button.hidden=!data.hasMore;
    const shown=$('quick-search-results').querySelectorAll('.song-entry').length;
    $('quick-search-state').textContent=`已显示 ${shown}${data.total?` / 共 ${data.total}`:''} 首`;
  }catch(error){if(request===quickSearchRequest&&account===libraryAccount){quickSearchMoreFailed=true;$('quick-search-state').textContent=`加载更多失败：${error.message}`;}}
  finally{if(request===quickSearchRequest&&account===libraryAccount){quickSearchLoading=false;button.disabled=false;button.textContent=quickSearchMoreFailed?'重试加载更多':'加载更多歌曲';}}
}
function scheduleQuickSearch(){quickSearchRequest++;clearTimeout(quickSearchTimer);$('quick-search-retry').hidden=true;$('quick-search-results').setAttribute('aria-busy','false');if(quickSearchComposing)return;$('quick-search-clear').hidden=!$('quick-search').value;$('quick-search-more').disabled=true;clearTimeout(quickSearchTimer);quickSearchTimer=setTimeout(renderQuickResults,260);}
$('quick-search-more').onclick=loadMoreQuickResults;
$('quick-search-retry').onclick=()=>{clearTimeout(quickSearchTimer);void renderQuickResults();};
const moreObserver=new IntersectionObserver(([entry])=>{
  if(entry.isIntersecting&&!$('more').hidden&&visible<filtered.length){
    visible=Math.min(visible+60,filtered.length);renderSongs(true);
  }
},{rootMargin:'400px 0px'});
moreObserver.observe($('more'));

function libraryViewActive(){return $('history-panel').hidden&&!document.body.classList.contains('mobile-player-open');}
function rememberLibraryView(){
  if(restoringLibrary||displayedPlaylistId!==libraryPlaylistId||!libraryAccount||!libraryViewActive())return;
  libraryViews.write(libraryAccount,libraryPlaylistId,{query:$('search').value.slice(0,160),visible:Math.min(10000,Math.max(60,visible)),top:Math.max(0,window.scrollY)});
}
function restoreLibraryView(view){
  if(!view)return;
  if(!libraryViewActive()){libraryRestore=view;return;}
  libraryRestore=null;
  const generation=locateGeneration,target=Math.min(filtered.length,view.visible);
  const token={};restoringLibrary=token;
  const append=()=>{
    if(generation!==locateGeneration){if(restoringLibrary===token)restoringLibrary=false;return;}
    if(visible<target){visible=Math.min(target,visible+240);renderSongs(true);requestAnimationFrame(append);}
    else{window.scrollTo({top:view.top,behavior:'instant'});restoringLibrary=false;}
  };
  requestAnimationFrame(append);
}
function displayPlaylist(data){
  const same=displayedPlaylistId===data.id&&JSON.stringify(songs)===JSON.stringify(data.songs);
  const resume=libraryRestore||(displayedPlaylistId===data.id&&songs.length?
    libraryViewActive()?{query:$('search').value,visible,top:window.scrollY}:libraryViews.read(libraryAccount,data.id):null)||
    {query:$('search').value,visible:60,top:0};
  displayedPlaylistId=data.id;songs=data.songs;
  $('playlist-title').textContent=data.title;$('song-count').textContent=`${songs.length} 首`;
  const selector=$('qq-playlist');
  if(![...selector.options].some(option=>option.value===data.id))selector.add(new Option(data.title,data.id));
  selector.value=data.id;
  if(!same){
    const view=resume;libraryRestore=null;
    if(view)$('search').value=view.query;
    locateGeneration++;visible=60;renderSongs();restoreLibraryView(view);
  }
  else updateCachedRowAvailability();
}
function updateCachedRowAvailability(){
  if(!libraryReady)return;
  for(const button of $('song-list').querySelectorAll('button[data-library-pending]')){button.disabled=false;delete button.dataset.libraryPending;}
}
function setLibraryContext(account,id){
  const accountChanged=libraryAccount!==account;
  const changed=libraryAccount!==account||libraryPlaylistId!==id;
  if(changed){rememberLibraryView();libraryRestore=libraryViews.read(account,id);}
  libraryAccount=account;libraryPlaylistId=id;libraryReady=Boolean(account&&id);
  $('playlist-open').disabled=!libraryReady;
  if(changed){
    playlistRequest++;songs=[];displayedPlaylistId='';visible=60;$('search').value='';renderSongs();
    $('account-state').hidden=true;
    $('playlist-title').textContent=libraryReady?'正在加载歌单…':'请登录 QQ 音乐';$('song-count').textContent='';
  }
  if(accountChanged){quickSearchRequest++;clearTimeout(quickSearchTimer);$('quick-search-retry').hidden=true;$('quick-search-results').setAttribute('aria-busy','false');quickSearchInitialized=false;quickSearchPage=0;quickSearchLoading=false;$('quick-search-results').replaceChildren($('quick-search-more'));$('quick-search-more').hidden=true;historyRequest++;$('history-list').replaceChildren();$('history-state').textContent='正在读取本地记录…';playlistOptions=[];$('qq-playlist').replaceChildren();renderPlaylistChoices();}
  const saved=playlistCache.read(account,id);
  if(saved)displayPlaylist(saved.data);
  else if(!changed)updateCachedRowAvailability();
}
async function loadPlaylist(refresh=false){
  const request=++playlistRequest,account=libraryAccount,id=libraryPlaylistId;
  $('refresh').disabled=true;
  const hasSnapshot=displayedPlaylistId===id;
  if(!hasSnapshot)$('list-state').textContent='正在加载歌单…';
  try{
    const data=await api(`/api/playlist${refresh?'?refresh=1':''}`);
    if(request!==playlistRequest||account!==libraryAccount||id!==libraryPlaylistId)return;
    if(data.account!==account||data.id!==id)throw Error('歌单已切换，请重新打开网页。');
    displayPlaylist(data);playlistCache.write(account,data);$('account-state').hidden=true;
  }catch(e){
    if(request!==playlistRequest)return;
    if(!hasSnapshot){songs=[];$('song-list').replaceChildren();markCurrentPlaylistSong();$('list-state').textContent=e.message;}
    $('account-state').textContent=hasSnapshot?`更新失败，继续显示上次保存的歌单。${e.message}`:`${e.message} 可在“QQ 账号”中重新登录。`;
    $('account-state').hidden=false;
    if(refresh||!hasSnapshot)toast(e.message);
  }finally{if(request===playlistRequest)$('refresh').disabled=false;}
}
let historyRequest=0;
async function loadHistory(){
  const request=++historyRequest,account=libraryAccount;
  $('history-state').textContent='正在读取本地记录…';
  try{
    const {songs:recent}=await api('/api/history');
    if(request!==historyRequest||account!==libraryAccount)return;
    $('history-list').replaceChildren(...recent.map(song=>createSongRow(song,true)));
    $('history-state').textContent=recent.length?`最近点播 ${recent.length} 首 · 每个账号最多保留 100 首`:'还没有记录。从歌单或全曲库选择一首歌开始播放。';
    $('history-clear').hidden=!recent.length;
  }catch(error){if(request===historyRequest&&account===libraryAccount)$('history-state').textContent=error.message;}
}
function showLibraryView(view){
  const wasHistory=!$('history-panel').hidden;
  if(view==='history'&&!wasHistory)rememberLibraryView();
  locateGeneration++;
  const history=view==='history';
  $('playlist-panel').hidden=history;$('history-panel').hidden=!history;
  $('playlist-tab').setAttribute('aria-selected',String(!history));
  $('history-tab').setAttribute('aria-selected',String(history));
  $('playlist-tab').tabIndex=history?-1:0;
  $('history-tab').tabIndex=history?0:-1;
  const label=history?'刷新最近播放':'刷新歌单';
  $('refresh').setAttribute('aria-label',label);$('refresh').title=label;$('refresh-label').textContent=label;
  markCurrentPlaylistSong();
  if(history)void loadHistory();
  else if(wasHistory)restoreLibraryView(libraryRestore||libraryViews.read(libraryAccount,libraryPlaylistId));
}
$('playlist-tab').onclick=()=>showLibraryView('playlist');
$('history-tab').onclick=()=>showLibraryView('history');
for(const tab of [$('playlist-tab'),$('history-tab')])tab.onkeydown=event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const next=event.key==='ArrowRight'||event.key==='End'?'history':'playlist';
  showLibraryView(next);
  $(next==='history'?'history-tab':'playlist-tab').focus();
};
$('history-clear').onclick=async()=>{
  if(!confirm('清空这个 QQ 账号在本网页的最近播放记录？'))return;
  try{await api('/api/history',{method:'DELETE'});await loadHistory();}catch(error){toast(error.message);}
};
async function loadCatalog(refresh=false){
  const account=libraryAccount,id=libraryPlaylistId;
  const data=await api(`/api/playlists${refresh?'?refresh=1':''}`);
  if(account!==libraryAccount||id!==libraryPlaylistId)return;
  playlistOptions=data.playlists;
  const selector=$('qq-playlist');selector.replaceChildren();
  for(const item of data.playlists){const option=new Option(`${item.title} · ${item.count} 首`,item.id);selector.add(option);}
  if(data.selectedId!==libraryPlaylistId){setLibraryContext(account,data.selectedId);void loadPlaylist();}
  selector.value=libraryPlaylistId;
  renderPlaylistChoices();
  return data;
}
function renderPlaylistChoices(){
  const list=$('playlist-list'),query=$('playlist-filter').value.trim().toLocaleLowerCase();
  const matches=playlistOptions.filter(item=>item.title.toLocaleLowerCase().includes(query));
  list.replaceChildren();
  $('playlist-list-state').textContent=query?`找到 ${matches.length} 个歌单`:`共 ${playlistOptions.length} 个歌单`;
  for(const item of matches){
    const button=document.createElement('button');button.type='button';button.className='playlist-choice';
    const selected=item.id===$('qq-playlist').value;
    if(selected){button.classList.add('selected');button.setAttribute('aria-current','true');}
    const copy=document.createElement('span');copy.className='playlist-choice-copy';
    const title=document.createElement('strong');title.textContent=item.title;
    const detail=document.createElement('small');detail.textContent=`${{liked:'QQ 音乐',created:'自建歌单',collected:'收藏歌单'}[item.source]||'歌单'} · ${item.count} 首`;
    copy.append(title,detail);
    const marker=document.createElement('span');marker.className='playlist-choice-marker';marker.setAttribute('aria-hidden','true');marker.textContent=selected?'✓':'›';
    button.append(copy,marker);button.onclick=()=>selectPlaylist(item.id,button);list.append(button);
  }
}
async function selectPlaylist(id,button){
  if(id===$('qq-playlist').value){$('playlist-dialog').close();return;}
  for(const choice of $('playlist-list').querySelectorAll('button'))choice.disabled=true;
  button.querySelector('.playlist-choice-marker').textContent='…';
  try{await api('/api/playlists/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});setLibraryContext(libraryAccount,id);await loadPlaylist();$('playlist-dialog').close();}
  catch(error){toast(error.message);await loadCatalog();}
  finally{renderPlaylistChoices();}
}
async function checkSession(){try{const state=await api('/api/qq/session');setLibraryContext(state.active||'',state.selectedId||'');if(!state.connected){playlistCache.clear();queryCache.clear();libraryViews.clear();}localLogin=state.local;$('login').hidden=!state.canQrLogin;$('cookie-import').hidden=!state.local;$('login').textContent=state.connected?'添加或重新登录账号':'登录 QQ 音乐';$('login-help').textContent=state.local?'请用 QQ 扫码并确认。成功后歌单会自动刷新。':'请用另一台设备扫描二维码，或在 QQ 中识别二维码并确认。成功后歌单会自动刷新。';const accounts=state.accounts||[];const selector=$('qq-account');selector.replaceChildren();for(const account of accounts){const option=new Option(`QQ 账号 · 尾号 ${account.id.slice(-4)}`,account.id);selector.add(option);}selector.value=state.active||'';selector.disabled=accounts.length<2;$('account-count-hint').textContent=accounts.length===0?'尚未保存 QQ 音乐账号，请先登录。':accounts.length===1?'目前只保存了 1 个账号。先添加另一个账号，才能切换。':'选择账号后会自动刷新歌单。';$('account-label').textContent=state.active?`账号 · ${state.active.slice(-4)}`:'QQ 账号';return state;}catch(e){toast(e.message);return null;}}
let qrGeneration=0,qrPolling=false;
function stopQr(){clearInterval(qrTimer);qrTimer=null;qrGeneration++;qrPolling=false;}
async function startQr(){
  stopQr();const generation=qrGeneration;
  $('qr-state').hidden=false;$('qr-state').textContent='正在获取二维码…';$('qr-image').hidden=true;
  try{
    const data=await api('/api/qq/login/qr',{method:'POST'});
    if(generation!==qrGeneration||!$('login-dialog').open)return;
    $('qr-image').src=data.image;$('qr-image').hidden=false;$('qr-state').textContent='请用 QQ 扫码并确认登录';
    qrTimer=setInterval(pollQr,2500);
  }catch(e){if(generation===qrGeneration&&$('login-dialog').open)$('qr-state').textContent=e.message;}
}
async function pollQr(){
  if(qrPolling||!$('login-dialog').open)return;
  const generation=qrGeneration;qrPolling=true;
  try{
    const data=await api('/api/qq/login/poll');
    if(generation!==qrGeneration||!$('login-dialog').open)return;
    if(data.state==='waiting')return;
    if(data.state==='scanned'){$('qr-state').textContent='已扫码，请在手机上确认';return;}
    if(data.state==='expired'){stopQr();$('qr-state').textContent='二维码已过期，请重新获取。';return;}
    if(data.state==='connected'){stopQr();$('login-dialog').close();await checkSession();await loadCatalog(true);await loadPlaylist(true);toast('QQ 音乐已登录');}
  }catch(e){if(generation===qrGeneration){stopQr();$('qr-state').textContent=e.message;}}
  finally{if(generation===qrGeneration)qrPolling=false;}
}
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
const dialogIds=['login-dialog','account-dialog','playlist-dialog','lyrics-dialog','quick-search-dialog','queue-dialog','sleep-dialog','song-action-dialog','queue-action-dialog','rooms-dialog','utilities-dialog'];
for(const id of dialogIds){
  const dialog=$(id);
  dialog.addEventListener('keydown',()=>dialog.classList.remove('suppress-initial-focus'));
  dialog.addEventListener('close',()=>{dialog.classList.remove('suppress-initial-focus');if(id==='quick-search-dialog')dialog.style.top='';});
  bindBackdropDismiss(dialog);
  bindDialogEditing(dialog);
}
function bindSwipeToDismiss(id){
  const sheet=$(id);
  let gesture=null,closeTimer,settleTimer,suppressClick=false;
  const mobile=()=>matchMedia('(max-width:720px)').matches;
  const canStart=(target,x,y)=>{
    if(target===sheet){const b=sheet.getBoundingClientRect();if(x<b.left||x>b.right||y<b.top||y>b.bottom)return false;}
    if(!sheet.open||!mobile()||target.closest('input,textarea,select,.queue-volume-slider,.volume-slider,.safe-volume-track'))return false;
    if(target.closest('.queue-list')&&$('queue-list').scrollTop>1)return false;
    if(target.closest('.lyrics-list')&&$('lyrics-list').scrollTop>1)return false;
    if(target.closest('.playlist-list')&&$('playlist-list').scrollTop>1)return false;
    return sheet.scrollTop<=1;
  };
  const start=(x,y,target)=>{
    if(!canStart(target,x,y))return;
    clearTimeout(settleTimer);
    sheet.classList.remove('sheet-settling');
    gesture={x,y,at:performance.now(),offset:0,dragging:false};
  };
  const move=(x,y,event)=>{
    if(!gesture)return;
    const dx=x-gesture.x,dy=y-gesture.y;
    if(!gesture.dragging){
      if(dy<9||Math.abs(dy)<Math.abs(dx)*1.2)return;
      gesture.dragging=true;
      sheet.classList.add('sheet-dragging');
    }
    event.preventDefault();
    gesture.offset=Math.max(0,dy);
    sheet.style.setProperty('--sheet-offset',`${gesture.offset}px`);
  };
  const finish=()=>{
    if(!gesture)return;
    const {offset,at,dragging}=gesture;
    gesture=null;
    if(!dragging)return;
    suppressClick=true;
    setTimeout(()=>{suppressClick=false;},350);
    sheet.classList.remove('sheet-dragging');
    sheet.style.removeProperty('--sheet-offset');
    if(offset>90||(offset>35&&offset/Math.max(1,performance.now()-at)>.55)){
      if(matchMedia('(prefers-reduced-motion: reduce)').matches){sheet.close();return;}
      sheet.classList.add('sheet-dismissing');
      closeTimer=setTimeout(()=>{if(sheet.open)sheet.close();},260);
    }else{
      sheet.classList.add('sheet-settling');
      settleTimer=setTimeout(()=>sheet.classList.remove('sheet-settling'),290);
    }
  };
  sheet.addEventListener('touchstart',event=>{
    if(event.touches.length!==1){gesture=null;sheet.classList.remove('sheet-dragging');sheet.style.removeProperty('--sheet-offset');return;}
    if(event.touches.length===1)start(event.touches[0].clientX,event.touches[0].clientY,event.target);
  },{passive:true});
  sheet.addEventListener('touchmove',event=>{
    if(event.touches.length===1)move(event.touches[0].clientX,event.touches[0].clientY,event);
  },{passive:false});
  sheet.addEventListener('touchend',finish);
  sheet.addEventListener('touchcancel',()=>{gesture=null;sheet.classList.remove('sheet-dragging');sheet.style.removeProperty('--sheet-offset');});
  sheet.addEventListener('pointerdown',event=>{
    if(event.pointerType==='mouse'&&event.button===0)start(event.clientX,event.clientY,event.target);
  });
  window.addEventListener('pointermove',event=>{
    if(event.pointerType==='mouse')move(event.clientX,event.clientY,event);
  });
  window.addEventListener('pointerup',event=>{if(event.pointerType==='mouse')finish();});
  window.addEventListener('pointercancel',()=>{gesture=null;sheet.classList.remove('sheet-dragging');sheet.style.removeProperty('--sheet-offset');});
  sheet.addEventListener('click',event=>{
    if(suppressClick){event.preventDefault();event.stopImmediatePropagation();suppressClick=false;}
  },true);
  sheet.addEventListener('close',()=>{
    clearTimeout(closeTimer);clearTimeout(settleTimer);gesture=null;suppressClick=false;
    sheet.classList.remove('sheet-dragging','sheet-settling','sheet-dismissing');
    sheet.style.removeProperty('--sheet-offset');
  });
}
bindSwipeToDismiss('queue-dialog');
bindSwipeToDismiss('utilities-dialog');
bindSwipeToDismiss('lyrics-dialog');
for(const id of ['account-dialog','playlist-dialog','login-dialog','sleep-dialog','rooms-dialog','song-action-dialog','queue-action-dialog'])bindSwipeToDismiss(id);
syncVisualViewport();
window.visualViewport?.addEventListener('resize',placeQuickSearch);
window.visualViewport?.addEventListener('scroll',placeQuickSearch);
$('account-open').onclick=e=>{showDialog('account-dialog',e);updateMiniVisibility();};
$('account-close').onclick=()=>$('account-dialog').close();
$('account-dialog').addEventListener('close',updateMiniVisibility);
$('playlist-open').onclick=event=>{$('playlist-filter').value='';renderPlaylistChoices();showDialog('playlist-dialog',event);updateMiniVisibility();};
$('playlist-close').onclick=()=>$('playlist-dialog').close();
$('playlist-filter').oninput=renderPlaylistChoices;
$('playlist-dialog').addEventListener('close',updateMiniVisibility);
$('login').onclick=e=>{$('account-dialog').close();showDialog('login-dialog',e);updateMiniVisibility();startQr();};$('login-back').onclick=e=>{$('login-dialog').close();showDialog('account-dialog',e);updateMiniVisibility();};$('login-close').onclick=()=>$('login-dialog').close();$('login-dialog').onclose=stopQr;$('qr-retry').onclick=startQr;
$('lyrics-open').onclick=$('mini-lyric-open').onclick=e=>{showDialog('lyrics-dialog',e);updateMiniVisibility();renderLyricsAt(positionAnchor.seconds+(positionAnchor.playing?(Date.now()-positionAnchor.at)/1000:0));scrollActiveLyric();};
$('lyrics-close').onclick=()=>$('lyrics-dialog').close();$('lyrics-dialog').addEventListener('close',updateMiniVisibility);
$('cookie-save').onclick=async()=>{const button=$('cookie-save');button.disabled=true;try{await api('/api/qq/login/cookie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:$('cookie-input').value})});$('cookie-input').value='';$('login-dialog').close();stopQr();await checkSession();await loadCatalog(true);await loadPlaylist(true);toast('QQ 音乐登录状态已保存');}catch(e){toast(e.message);}finally{button.disabled=false;}};
async function control(action,value){
  if(!currentStatus){toast('正在读取房间状态，请稍候');return;}
  const room=roomGeneration;
  const modeOperation=['mute','repeatOne','repeatAll','crossfade'].includes(action)?++modeGeneration:null;
  if(modeOperation){
    statusRequest++;
    pendingModes.set(action,{value:Boolean(value),generation:modeOperation,acknowledged:false,expires:Date.now()+6500});
    if(value&&action==='repeatOne')pendingModes.set('repeatAll',{value:false,generation:modeOperation,acknowledged:false,expires:Date.now()+6500});
    if(value&&action==='repeatAll')pendingModes.set('repeatOne',{value:false,generation:modeOperation,acknowledged:false,expires:Date.now()+6500});
    renderStatus({...currentStatus,position:duration(Math.floor(livePosition())),...Object.fromEntries([...pendingModes].map(([key,pending])=>[key,pending.value]))});
  }
  if(['play','pause','next','previous','seek'].includes(action))playRequestGeneration++;
  const shuffleOperation=action==='shuffle'?++shuffleGeneration:null;
  if(shuffleOperation){
    pendingShuffleValue=Boolean(value);
    if(currentStatus)currentStatus={...currentStatus,shuffle:pendingShuffleValue};
    for(const id of ['shuffle','mini-shuffle','queue-shuffle']){
      $(id).classList.toggle('active',pendingShuffleValue);
      $(id).setAttribute('aria-pressed',String(pendingShuffleValue));
      $(id).title=pendingShuffleValue?'关闭随机播放':'随机播放';
    }
  }
  const toggle=action==='repeatAll'?$('repeat-all'):action==='crossfade'?$('crossfade'):null;
  if(toggle)toggle.disabled=true;
  const expected=action==='play'||action==='next'||action==='previous'?true:action==='pause'?false:action==='seek'?Boolean(currentStatus?.playing):null;
  let operation=null;
  if(action==='seek')operation=beginTransportSync(expected,Number(value));
  else if(expected!==null)operation=beginTransportSync(expected,undefined,action==='next'||action==='previous');
  try{
    await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value})});
    if(room!==roomGeneration)return;
    if(modeOperation){statusRequest++;for(const pending of pendingModes.values())if(pending.generation===modeOperation)pending.acknowledged=true;}
    if(shuffleOperation)statusRequest++;
    if(shuffleOperation===shuffleGeneration)pendingShuffleValue=null;
    if(operation&&!transportOperations.isCurrent(operation))return;
    if(expected!==null)await settleTransport(expected,0,operation);else await updateStatus();
  }
  catch(e){if(room!==roomGeneration)return;if(modeOperation)for(const [key,pending] of pendingModes)if(pending.generation===modeOperation)pendingModes.delete(key);if(shuffleOperation===shuffleGeneration)pendingShuffleValue=null;if(!operation||transportOperations.isCurrent(operation)){expectedPlaying=null;transportExpectation=null;transportSettlingUntil=0;await updateStatus();toast(e.message);}}finally{if(toggle)toggle.disabled=false;}
}
async function sendVolume(){
  if(volumeSending)return;
  volumeSending=true;
  try{
    while(volumeDesired!==null){
      const pending=volumeDesired;volumeDesired=null;
      if(pending.generation!==roomGeneration)continue;
      try{await api(`/api/control?room=${encodeURIComponent(pending.room)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'volume',value:pending.value})});}
      catch(error){if(pending.generation===roomGeneration)toast(error.message);}
    }
  }finally{volumeSending=false;await updateStatus();}
}
function queueVolume(value){volumeDesired={value,room:selectedRoomId,generation:roomGeneration};void sendVolume();}
function showVolume(value){
  if(!currentStatus)return;
  const safe=Math.max(0,Math.min(100,Math.round(value)));
  for(const prefix of ['','mini-','queue-']){$(prefix+'volume').value=safe;paintRange($(prefix+'volume'));$(prefix+'volume-value').textContent=`${safe}%`;}
  queueVolume(safe);
}
function guardVolumeTrack(slider,onValue=showVolume){
  const track=slider.parentElement;
  let pointerId=null,startValue=0;
  track.addEventListener('pointerdown',event=>{
    if(event.button!==0||pointerId!==null)return;
    const rect=track.getBoundingClientRect(),thumb=20;
    startValue=Number(slider.value);
    const center=rect.left+thumb/2+(rect.width-thumb)*startValue/100;
    // Block native range jumps even when a caller has no pointer-events CSS.
    event.preventDefault();
    if(Math.abs(event.clientX-center)>18)return;
    pointerId=event.pointerId;volumeDragging=true;
    track.setPointerCapture(pointerId);
  });
  track.addEventListener('pointermove',event=>{
    if(pointerId!==event.pointerId)return;
    const rect=track.getBoundingClientRect(),thumb=20;
    const raw=Math.round((event.clientX-rect.left-thumb/2)/Math.max(1,rect.width-thumb)*100);
    const next=Math.max(0,Math.min(100,startValue+10,raw));
    if(next!==Number(slider.value))onValue(next);
  });
  const end=event=>{if(pointerId===event.pointerId){pointerId=null;volumeDragging=false;}};
  for(const event of ['pointerup','pointercancel','lostpointercapture'])track.addEventListener(event,end);
  slider.addEventListener('input',()=>onValue(Number(slider.value)));
}
function bindPlayer(prefix){
  $(prefix+'toggle-play').onclick=event=>{event.currentTarget.blur();control(currentStatus?.playing?'pause':'play');};
  $(prefix+'previous').onclick=event=>{event.currentTarget.blur();control('previous');};$(prefix+'next').onclick=event=>{event.currentTarget.blur();control('next');};
  $(prefix+'shuffle').onclick=()=>control('shuffle',!currentStatus?.shuffle);
  $(prefix+'repeat-one').onclick=()=>control('repeatOne',!currentStatus?.repeatOne);
  $(prefix+'mute').onclick=()=>control('mute',!currentStatus?.mute);
  guardVolumeTrack($(prefix+'volume'));
  for(const [suffix,change] of [['down',-1],['up',1]]){$(prefix+`volume-${suffix}`).onclick=event=>{event.currentTarget.blur();showVolume(Number($(prefix+'volume').value)+change);};}
  $(prefix+'seek').addEventListener('pointerdown',()=>{seeking=true;});
  for(const event of ['pointerup','pointercancel','lostpointercapture','blur'])$(prefix+'seek').addEventListener(event,()=>{seeking=false;});
  $(prefix+'seek').oninput=e=>{seeking=true;for(const p of ['','mini-']){$(p+'seek').value=e.target.value;paintRange($(p+'seek'));$(p+'position').textContent=duration(Number(e.target.value));}};
  $(prefix+'seek').onchange=async e=>{const value=Number(e.target.value);try{await control('seek',value);}finally{seeking=false;}};
}
bindPlayer('');bindPlayer('mini-');
for(const [id,action] of [['queue-previous','previous'],['queue-next','next']])$(id).onclick=e=>{e.currentTarget.blur();control(action);};
$('queue-toggle-play').onclick=e=>{e.currentTarget.blur();control(currentStatus?.playing?'pause':'play');};
$('queue-shuffle').onclick=()=>control('shuffle',!currentStatus?.shuffle);
$('queue-repeat-one').onclick=()=>control('repeatOne',!currentStatus?.repeatOne);
$('queue-mute').onclick=()=>control('mute',!currentStatus?.mute);
guardVolumeTrack($('queue-volume'));
window.addEventListener('pointerup',()=>{volumeDragging=false;seeking=false;});
window.addEventListener('pointercancel',()=>{volumeDragging=false;seeking=false;});
let mobilePlayerOpen=false,mobilePlayerClosing=false,mobilePlayerCloseTimer;
function setMobilePlayer(open){
  const player=document.querySelector('.player');
  if(open){
    if(mobilePlayerOpen&&!mobilePlayerClosing)return;
    clearTimeout(mobilePlayerCloseTimer);
    rememberLibraryView();mobilePlayerOpen=true;mobilePlayerClosing=false;
    player.style.removeProperty('--sheet-drag-y');
    document.body.classList.remove('mobile-player-closing','mobile-player-dragging');
    document.body.classList.add('mobile-player-open');
    if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
      document.body.classList.add('mobile-player-opening');
      void player.offsetHeight;
      requestAnimationFrame(()=>document.body.classList.remove('mobile-player-opening'));
    }
    updateMiniVisibility();
    return;
  }
  if(!mobilePlayerOpen||mobilePlayerClosing)return;
  const finish=()=>{
    mobilePlayerOpen=false;mobilePlayerClosing=false;
    document.body.classList.remove('mobile-player-open','mobile-player-closing','mobile-player-dragging','mobile-player-opening');
    player.style.removeProperty('--sheet-drag-y');
    updateMiniVisibility();
    if(libraryRestore)restoreLibraryView(libraryRestore);
  };
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return;}
  mobilePlayerClosing=true;
  document.body.classList.remove('mobile-player-dragging');
  document.body.classList.add('mobile-player-closing');
  mobilePlayerCloseTimer=setTimeout(finish,300);
}
function updateMiniVisibility(){
  const dialogOpen=dialogIds.some(id=>$(id).open);
  const mobile=window.matchMedia('(max-width:720px)').matches;
  if(!mobile&&mobilePlayerOpen){clearTimeout(mobilePlayerCloseTimer);mobilePlayerOpen=false;mobilePlayerClosing=false;document.body.classList.remove('mobile-player-open','mobile-player-opening','mobile-player-closing','mobile-player-dragging');document.querySelector('.player').style.removeProperty('--sheet-drag-y');}
  const scrolled=mobile?window.scrollY>500:document.querySelector('.player').getBoundingClientRect().bottom<=0;
  $('mini-player').hidden=dialogOpen||mobilePlayerOpen||(!mobile&&!scrolled);
  $('floating-actions').hidden=dialogOpen||mobilePlayerOpen||!scrolled;
  const searchBounds=$('catalog-search-open').getBoundingClientRect();
  const searchVisible=searchBounds.width>0&&searchBounds.bottom>0&&searchBounds.top<window.innerHeight;
  $('quick-search-open').hidden=mobile||searchVisible;
  document.querySelector('.mobile-nav').hidden=dialogOpen||mobilePlayerOpen;
  $('mobile-dock').hidden=mobile&&(dialogOpen||mobilePlayerOpen);
}
$('mobile-library-open').onclick=()=>setMobilePlayer(false);
$('mobile-player-back').onclick=()=>setMobilePlayer(false);
$('mini-expand').onclick=()=>setMobilePlayer(true);
$('mobile-search-open').onclick=e=>openCatalogSearch(e);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&mobilePlayerOpen&&!dialogIds.some(id=>$(id).open))setMobilePlayer(false);});
function bindMobileSwipe(element,direction,action){
  let start=null,mouseStart=null;
  const blocked=target=>Boolean(target.closest('button:not(#mobile-player-back):not(#mini-expand),input,textarea,select,dialog,.volume-slider,.safe-volume-track'));
  const move=(origin,x,y)=>{
    if(!origin||direction!=='down'||!mobilePlayerOpen||mobilePlayerClosing)return false;
    const dx=x-origin.x,dy=y-origin.y;
    if(!origin.dragging){
      if(dy<5||Math.abs(dx)>dy*.75)return false;
      origin.dragging=true;
    }
    document.body.classList.add('mobile-player-dragging');
    element.style.setProperty('--sheet-drag-y',`${Math.max(0,Math.min(dy,window.innerHeight))}px`);
    return true;
  };
  const reset=()=>{document.body.classList.remove('mobile-player-dragging');element.style.removeProperty('--sheet-drag-y');};
  const finish=(origin,x,y)=>{
    if(!origin){reset();return;}
    const dx=x-origin.x,dy=y-origin.y;
    if(Math.abs(dx)>Math.abs(dy)*.75||Math.abs(dy)<70){reset();return;}
    if(direction==='down'&&dy>0||direction==='up'&&dy<0)action();
    else reset();
  };
  element.addEventListener('touchstart',event=>{
    if(!window.matchMedia('(max-width:720px)').matches||event.touches.length!==1||blocked(event.target)){start=null;return;}
    start={x:event.touches[0].clientX,y:event.touches[0].clientY};
  },{passive:true});
  element.addEventListener('touchmove',event=>{if(start&&event.touches.length===1&&move(start,event.touches[0].clientX,event.touches[0].clientY))event.preventDefault();},{passive:false});
  element.addEventListener('touchend',event=>{
    if(!start||event.changedTouches.length!==1){start=null;return;}
    const origin=start;start=null;
    finish(origin,event.changedTouches[0].clientX,event.changedTouches[0].clientY);
  },{passive:true});
  element.addEventListener('touchcancel',()=>{start=null;reset();},{passive:true});
  element.addEventListener('pointerdown',event=>{
    if(event.pointerType!=='mouse'||!window.matchMedia('(max-width:720px)').matches||blocked(event.target))return;
    mouseStart={x:event.clientX,y:event.clientY};
    if(!event.target.closest('#mobile-player-back,#mini-expand'))element.setPointerCapture?.(event.pointerId);
  });
  element.addEventListener('pointermove',event=>{if(event.pointerType==='mouse'&&mouseStart)move(mouseStart,event.clientX,event.clientY);});
  element.addEventListener('pointerup',event=>{const origin=mouseStart;mouseStart=null;if(event.pointerType==='mouse')finish(origin,event.clientX,event.clientY);});
  element.addEventListener('pointercancel',()=>{mouseStart=null;reset();});
}
bindMobileSwipe(document.querySelector('.player'),'down',()=>{if(mobilePlayerOpen&&!dialogIds.some(id=>$(id).open))setMobilePlayer(false);});
bindMobileSwipe($('mini-player'),'up',()=>setMobilePlayer(true));
window.addEventListener('scroll',updateMiniVisibility,{passive:true});window.addEventListener('resize',updateMiniVisibility);
$('login-dialog').addEventListener('close',updateMiniVisibility);
updateMiniVisibility();
function filterPlaylist(){if(playlistSearchComposing)return;locateGeneration++;visible=60;renderSongs();rememberLibraryView();}
$('search').oninput=filterPlaylist;
$('search').addEventListener('compositionstart',()=>{playlistSearchComposing=true;});
$('search').addEventListener('compositionend',()=>{playlistSearchComposing=false;filterPlaylist();});
window.addEventListener('scroll',()=>{clearTimeout(browseSaveTimer);browseSaveTimer=setTimeout(rememberLibraryView,300);},{passive:true});
window.addEventListener('pagehide',rememberLibraryView);
for(const event of ['touchstart','wheel'])window.addEventListener(event,()=>{if(restoringLibrary){locateGeneration++;restoringLibrary=false;}},{passive:true});
async function refreshLibrary(){
  if($('refresh').disabled)return;
  $('refresh').disabled=true;
  try{if(!$('history-panel').hidden)await loadHistory();else{await loadCatalog(true);await loadPlaylist(true);}}
  catch(error){toast(error.message);}
  finally{$('refresh').disabled=false;}
}
$('refresh').onclick=refreshLibrary;
$('qq-account').onchange=async e=>{const selector=e.currentTarget;selector.disabled=true;try{await api('/api/qq/session/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:selector.value})});await checkSession();await loadCatalog(true);await loadPlaylist(true);if(!$('history-panel').hidden)await loadHistory();$('account-dialog').close();}catch(error){toast(error.message);await checkSession();}finally{selector.disabled=false;}};
function openCatalogSearch(event){
  showDialog('quick-search-dialog',event);
  if(!quickSearchInitialized)void renderQuickResults();
  updateMiniVisibility();
  if(!$('quick-search').value)$('quick-search').focus({preventScroll:true});
}
$('quick-search-clear').onclick=()=>{clearTimeout(quickSearchTimer);$('quick-search').value='';void renderQuickResults();$('quick-search').focus({preventScroll:true});};
$('quick-search').addEventListener('keydown',event=>{
  if(event.key!=='Enter'||event.isComposing||event.keyCode===229||quickSearchComposing)return;
  event.preventDefault();clearTimeout(quickSearchTimer);void renderQuickResults();$('quick-search').blur();
});
$('quick-search-open').onclick=openCatalogSearch;
$('catalog-search-open').onclick=openCatalogSearch;
$('quick-search-close').onclick=()=>$('quick-search-dialog').close();
$('search-library-return').onclick=()=>$('quick-search-dialog').close();
$('search-current').onclick=()=>$('quick-search').focus({preventScroll:true});
$('quick-search-dialog').addEventListener('close',updateMiniVisibility);
$('quick-search').oninput=scheduleQuickSearch;
$('quick-search').addEventListener('compositionstart',()=>{quickSearchComposing=true;quickSearchRequest++;clearTimeout(quickSearchTimer);$('quick-search-retry').hidden=true;$('quick-search-results').setAttribute('aria-busy','false');});
$('quick-search').addEventListener('compositionend',()=>{quickSearchComposing=false;scheduleQuickSearch();});
$('quick-search-dialog').addEventListener('pointerdown',event=>{if(event.target.closest('.search-wrap,.dialog-head,.search-bottom-nav'))return;$('quick-search').blur();});
$('back-to-top').onclick=()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
let utilitiesReturnTo='';
$('utilities-open').onclick=event=>{utilitiesReturnTo='';$('utilities-back').hidden=true;showDialog('utilities-dialog',event);updateMiniVisibility();};
$('queue-utilities-open').onclick=event=>{utilitiesReturnTo='queue-dialog';$('utilities-back').hidden=false;$('queue-dialog').close();showDialog('utilities-dialog',event);updateMiniVisibility();};
$('utilities-back').onclick=event=>{$('utilities-dialog').close();if(utilitiesReturnTo==='queue-dialog'){showDialog('queue-dialog',event);void loadQueue(queueStart);}updateMiniVisibility();};
$('utilities-close').onclick=()=>$('utilities-dialog').close();
$('utilities-dialog').addEventListener('close',updateMiniVisibility);
$('repeat-all').onclick=()=>control('repeatAll',!currentStatus?.repeatAll);
$('crossfade').onclick=()=>control('crossfade',!currentStatus?.crossfade);
$('song-action-close').onclick=()=>$('song-action-dialog').close();
$('song-action-dialog').addEventListener('close',updateMiniVisibility);
async function addChosenSong(placement){
  const room=roomGeneration,song=chosenSong;if(!song)return;
  const actionGeneration=++songActionGeneration;
  const buttons=$('song-action-dialog').querySelectorAll('button');for(const button of buttons)button.disabled=true;
  try{await api('/api/queue/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mid:song.mid,placement})});if(room!==roomGeneration||actionGeneration!==songActionGeneration)return;$('song-action-dialog').close();toast(`${song.title}已${placement==='next'?'加入下一首':'加入队列末尾'}`);if($('queue-dialog').open)await loadQueue(queueStart);}
  catch(e){if(room===roomGeneration&&actionGeneration===songActionGeneration)toast(e.message);}finally{if(actionGeneration===songActionGeneration)for(const button of buttons)button.disabled=false;}
}
$('song-play-next').onclick=()=>addChosenSong('next');$('song-add-end').onclick=()=>addChosenSong('end');
let queueLoading=false,queueStart=0,queueRequest=0;
async function loadQueue(start=0,focusCurrent=false){
  const request=++queueRequest,room=roomGeneration;
  chosenQueueTrack=null;$('queue-action-dialog').close();$('queue-list').replaceChildren();$('queue-browse').hidden=true;$('queue-list').setAttribute('aria-busy','true');
  queueLoading=true;$('queue-refresh').disabled=true;$('queue-more').disabled=true;$('queue-prev').disabled=true;
  $('queue-state').textContent='正在读取 Sonos 播放队列…';
  try{
    const data=await api(`/api/queue?start=${start}`);
    if(request!==queueRequest||room!==roomGeneration)return;
    start=data.start;
    const fragment=document.createDocumentFragment();
    for(const track of data.tracks){
      const entry=document.createElement('div');entry.className='queue-entry';
      const row=document.createElement('button');row.type='button';row.className='queue-track';row.dataset.number=track.number;
      row.setAttribute('aria-label',`播放队列第 ${track.number} 首：${track.title}，${track.artist}`);
      const number=document.createElement('span');number.className='queue-number';number.textContent=track.number;
      const art=document.createElement('span');art.className='queue-art';if(/^[A-Za-z0-9]{14}$/.test(track.albumMid||'')){const image=document.createElement('img');image.src=`/api/qq/art?mid=${encodeURIComponent(track.albumMid)}`;image.alt='';image.loading='lazy';art.append(image);}
      const info=document.createElement('span');info.className='queue-info';
      const title=document.createElement('strong');title.textContent=track.title;
      const artist=document.createElement('small');artist.textContent=track.artist;
      info.append(title,artist);row.append(number,art,info);
      const more=document.createElement('button');more.type='button';more.className='queue-more-trigger';more.setAttribute('aria-label',`${track.title}的队列操作`);more.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
      more.onclick=e=>{queueActionGeneration++;for(const button of $('queue-action-dialog').querySelectorAll('button'))button.disabled=false;chosenQueueTrack=track;$('queue-action-name').textContent=`${track.number}. ${track.title} · ${track.artist}`;$('queue-move-up').disabled=track.number<=1;$('queue-move-down').disabled=track.number>=queueTotal;showDialog('queue-action-dialog',e);updateMiniVisibility();};
      row.onclick=async()=>{if(room!==roomGeneration)return;const playRequest=++playRequestGeneration;row.blur();row.disabled=true;let operation=null;try{await api('/api/queue/play',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:track.number,key:track.key})});if(playRequest!==playRequestGeneration||room!==roomGeneration)return;operation=beginTransportSync(true);const confirmed=await settleTransport(true,0,operation);if(!transportOperations.isCurrent(operation))return;if(!confirmed)throw Error('Sonos 尚未确认播放，请刷新队列后重试。');markCurrentQueueTrack();}catch(e){if(playRequest===playRequestGeneration&&(!operation||transportOperations.isCurrent(operation))){expectedPlaying=null;transportExpectation=null;transportSettlingUntil=0;await updateStatus();toast(e.message);}}finally{row.disabled=false;}};
      entry.append(row,more);fragment.append(entry);
    }
    $('queue-list').replaceChildren(fragment);$('queue-browse').hidden=Boolean(data.total);queueStart=start;queueTotal=data.total;
    $('queue-list').scrollTop=0;
    $('queue-state').textContent=data.total?`第 ${start+1}–${start+data.tracks.length} 首 / 共 ${data.total} 首`:'当前队列为空';
    $('queue-prev').hidden=start===0;
    $('queue-more').hidden=start+data.tracks.length>=data.total;
    markCurrentQueueTrack();
    if(focusCurrent){const list=$('queue-list'),current=list.querySelector('.queue-track.current');if(current)list.scrollTop=current.getBoundingClientRect().top-list.getBoundingClientRect().top+list.scrollTop-list.clientHeight/2;}
  }catch(e){if(request===queueRequest&&room===roomGeneration){$('queue-state').textContent=e.message;toast(e.message);}}
  finally{if(request===queueRequest){$('queue-list').setAttribute('aria-busy','false');queueLoading=false;$('queue-refresh').disabled=false;$('queue-more').disabled=false;$('queue-prev').disabled=false;}}
}
function markCurrentQueueTrack(){
  for(const row of $('queue-list').querySelectorAll('.queue-track'))row.classList.toggle('current',Number(row.dataset.number)===currentStatus?.track);
}
$('queue-open').onclick=e=>{showDialog('queue-dialog',e);updateMiniVisibility();loadQueue(Math.floor((Math.max(1,currentStatus?.track||1)-1)/100)*100,true);};
$('queue-browse').onclick=()=>{$('queue-dialog').close();setMobilePlayer(false);showLibraryView('playlist');requestAnimationFrame(()=>document.querySelector('.library').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));};
$('queue-close').onclick=()=>$('queue-dialog').close();
$('queue-refresh').onclick=()=>loadQueue(queueStart);
$('queue-prev').onclick=()=>loadQueue(Math.max(0,queueStart-100));
$('queue-more').onclick=()=>loadQueue(queueStart+100);
$('queue-dialog').addEventListener('close',updateMiniVisibility);
$('queue-action-close').onclick=()=>$('queue-action-dialog').close();
$('queue-action-dialog').addEventListener('close',updateMiniVisibility);
async function editChosenQueue(action,before){
  const room=roomGeneration,track=chosenQueueTrack;if(!track)return;
  const actionGeneration=++queueActionGeneration;
  const buttons=$('queue-action-dialog').querySelectorAll('button');for(const button of buttons)button.disabled=true;
  try{await api('/api/queue/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,number:track.number,key:track.key,before})});if(room!==roomGeneration||actionGeneration!==queueActionGeneration)return;$('queue-action-dialog').close();await loadQueue(queueStart);await updateStatus();}
  catch(e){if(room===roomGeneration&&actionGeneration===queueActionGeneration)toast(e.message);}finally{if(actionGeneration===queueActionGeneration)for(const button of buttons)button.disabled=false;}
}
$('queue-move-up').onclick=()=>editChosenQueue('move',chosenQueueTrack.number-1);
$('queue-move-down').onclick=()=>editChosenQueue('move',chosenQueueTrack.number+2);
$('queue-remove').onclick=()=>editChosenQueue('remove');
function selectRoom(id){
  if(selectedRoomId===id)return;
  songActionGeneration++;queueActionGeneration++;
  for(const id of ['song-action-dialog','queue-action-dialog'])for(const button of $(id).querySelectorAll('button'))button.disabled=false;
  selectedRoomId=id;roomGeneration++;statusRequest++;playRequestGeneration++;shuffleGeneration++;transportOperations.begin();
  lastStatusAt=0;statusFailed=false;lastQueueImportError='';
  expectedPlaying=null;transportExpectation=null;transportSettlingUntil=0;pendingShuffleValue=null;pendingModes.clear();
  volumeDesired=null;groupDesired=null;seeking=false;volumeDragging=false;
  currentStatus=null;positionAnchor={seconds:0,at:Date.now(),playing:false};lyricTrack='';lyrics=[];
  sleepRequest++;sleepWriteGeneration++;sleepSending=false;sleepEndsAt=null;renderSleep();$('sleep-feedback').hidden=true;$('sleep-form').setAttribute('aria-busy','false');
  for(const button of $('sleep-dialog').querySelectorAll('#sleep-form button,#sleep-cancel'))button.disabled=false;
  queueRequest++;queueLoading=false;chosenQueueTrack=null;$('queue-list').replaceChildren();$('queue-action-dialog').close();
  $('connection').textContent='正在切换房间…';
  try{localStorage.setItem('sonos-room-id',id);}catch{/* Storage is optional. */}
}
let roomsRequest=0;
async function loadRooms(refresh=false){
  const request=++roomsRequest;
  $('rooms-discover').disabled=true;
  $('rooms-state').textContent=refresh?'正在发现局域网内的 Sonos…':'正在读取房间…';
  try{
    const data=await api(`/api/rooms${refresh?'?refresh=1':''}`);
    if(request!==roomsRequest)return;
    roomData=data;
    if(!roomData.rooms.some(room=>room.id===selectedRoomId))selectRoom(roomData.defaultId);
    const selected=roomData.rooms.find(room=>room.id===selectedRoomId),fragment=document.createDocumentFragment();
    for(const room of roomData.rooms){
      const entry=document.createElement('div');entry.className='room-entry';
      const header=document.createElement('div');header.className='room-row';
      const name=document.createElement('strong');name.textContent=room.name;
      const button=document.createElement('button');button.type='button';button.textContent=room.id===selectedRoomId?'当前房间':'切换到这里';button.disabled=room.id===selectedRoomId;
      button.onclick=async()=>{selectRoom(room.id);await Promise.all([updateStatus(),loadSleep(),loadRooms()]);};
      header.append(name,button);entry.append(header);
      const group=document.createElement('small');group.textContent=room.id===selected.id?'当前控制房间':room.groupId===selected.groupId?`与 ${selected.name} 同组`:'独立播放';entry.append(group);
      if(room.volume!=null){
        const label=document.createElement('label');label.textContent=`${room.name}音量 ${room.volume}%`;
        const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max='100';slider.value=room.volume;slider.setAttribute('aria-label',`${room.name}音量`);
        const track=document.createElement('span');track.className='safe-volume-track';track.append(slider);paintRange(slider);
        const generation=roomGeneration;
        let desired=null,sending=false;
        const send=async()=>{
          if(sending)return;sending=true;
          try{while(desired!==null){const value=desired;desired=null;if(generation!==roomGeneration)break;await api(`/api/control?room=${encodeURIComponent(room.id)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'volume',value})});}}
          catch(error){desired=null;if(generation===roomGeneration)toast(error.message);}
          finally{sending=false;void updateStatus();}
        };
        guardVolumeTrack(slider,value=>{if(generation!==roomGeneration)return;slider.value=value;paintRange(slider);label.textContent=`${room.name}音量 ${value}%`;desired=value;void send();});
        entry.append(label,track);
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
  }catch(e){if(request===roomsRequest){$('rooms-state').textContent=e.message;toast(e.message);}}
  finally{if(request===roomsRequest)$('rooms-discover').disabled=false;}
}
async function changeGroup(input){
  try{await api('/api/rooms/group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});await loadRooms();await updateStatus();}
  catch(e){toast(e.message);}
}
$('rooms-open').onclick=e=>{$('rooms-back').hidden=false;$('utilities-dialog').close();showDialog('rooms-dialog',e);updateMiniVisibility();loadRooms();};
$('rooms-discover').onclick=async()=>{await loadRooms(true);await updateStatus();await loadSleep();};
$('rooms-back').onclick=e=>{$('rooms-dialog').close();showDialog('utilities-dialog',e);updateMiniVisibility();};
$('connection').onclick=e=>{$('rooms-back').hidden=true;showDialog('rooms-dialog',e);updateMiniVisibility();void loadRooms();};
$('rooms-close').onclick=()=>$('rooms-dialog').close();
$('rooms-dialog').addEventListener('close',updateMiniVisibility);
let groupDesired=null,groupSending=false;
async function sendGroupVolume(){
  if(groupSending)return;groupSending=true;
  try{while(groupDesired!==null){const pending=groupDesired;groupDesired=null;if(pending.generation!==roomGeneration)continue;try{await api(`/api/control?room=${encodeURIComponent(pending.room)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'groupVolume',value:pending.value})});}catch(error){if(pending.generation===roomGeneration)toast(error.message);}}}
  finally{groupSending=false;await updateStatus();}
}
guardVolumeTrack($('group-volume'),value=>{
  if(!currentStatus||currentStatus.groupSize<2)return;
  $('group-volume').value=value;paintRange($('group-volume'));$('group-volume-value').textContent=`${value}%`;
  groupDesired={value,room:selectedRoomId,generation:roomGeneration};void sendGroupVolume();
});
let sleepEndsAt=null,sleepRequest=0,sleepSending=false,sleepWriteGeneration=0;
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
  if(sleepSending)return;
  const request=++sleepRequest,room=roomGeneration;
  $('sleep-state').textContent='正在读取定时状态…';
  try{const data=await api('/api/sleep');if(request!==sleepRequest||room!==roomGeneration)return;sleepEndsAt=data.endsAt?Date.parse(data.endsAt):null;renderSleep();}
  catch(e){if(request===sleepRequest&&room===roomGeneration){$('sleep-state').textContent=e.message;toast(e.message);}}
}
async function setSleep(input){
  if(sleepSending)return;
  sleepSending=true;
  const write=++sleepWriteGeneration,request=++sleepRequest,room=roomGeneration;
  const buttons=$('sleep-dialog').querySelectorAll('#sleep-form button,#sleep-cancel');for(const button of buttons)button.disabled=true;
  $('sleep-form').setAttribute('aria-busy','true');$('sleep-feedback').hidden=true;
  try{const data=await api('/api/sleep',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});if(request!==sleepRequest||room!==roomGeneration)return;sleepEndsAt=data.endsAt?Date.parse(data.endsAt):null;renderSleep();$('sleep-feedback').textContent=input.mode==='cancel'?'已取消睡眠定时':'已设置，关闭网页后仍会按时停止';$('sleep-feedback').classList.remove('error');$('sleep-feedback').hidden=false;}
  catch(e){if(room===roomGeneration){$('sleep-feedback').textContent=`设置失败：${e.message}`;$('sleep-feedback').classList.add('error');$('sleep-feedback').hidden=false;}}
  finally{if(write===sleepWriteGeneration){sleepSending=false;$('sleep-form').setAttribute('aria-busy','false');for(const button of buttons)button.disabled=false;}}
}
$('sleep-open').onclick=e=>{$('sleep-feedback').hidden=true;$('utilities-dialog').close();showDialog('sleep-dialog',e);updateMiniVisibility();loadSleep();};
$('sleep-back').onclick=e=>{$('sleep-dialog').close();showDialog('utilities-dialog',e);updateMiniVisibility();};
for(const button of document.querySelectorAll('[data-sleep-minutes]'))button.onclick=()=>{const minutes=Number(button.dataset.sleepMinutes);$('sleep-minutes').value=String(minutes);void setSleep({mode:'minutes',minutes});};
$('sleep-close').onclick=()=>$('sleep-dialog').close();
$('sleep-dialog').addEventListener('close',updateMiniVisibility);
$('sleep-form').noValidate=true;
$('sleep-time').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();document.querySelector('#sleep-form button[value="until"]').click();}});
$('sleep-form').onsubmit=e=>{
  e.preventDefault();
  if(e.submitter?.value==='minutes'||!e.submitter&&document.activeElement===$('sleep-minutes')){
    const minutes=Number($('sleep-minutes').value);
    if(!Number.isInteger(minutes)||minutes<1||minutes>1440){toast('请输入 1 到 1440 分钟。');return;}
    return setSleep({mode:'minutes',minutes});
  }
  const value=$('sleep-time').value;
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)){toast('请选择停止时间');return;}
  const [hours,minutes]=value.split(':').map(Number),target=new Date();
  target.setHours(hours,minutes,0,0);
  if(target<=new Date())target.setDate(target.getDate()+1);
  setSleep({mode:'until',at:target.toISOString()});
};
$('sleep-cancel').onclick=()=>setSleep({mode:'cancel'});
const savedPlaylist=playlistCache.latest();
if(savedPlaylist){libraryAccount=savedPlaylist.account;libraryPlaylistId=savedPlaylist.data.id;libraryRestore=libraryViews.read(libraryAccount,libraryPlaylistId);displayPlaylist(savedPlaylist.data);$('playlist-open').disabled=true;}
checkSession().then(state=>{if(!state?.connected)return;void loadPlaylist();void loadCatalog().catch(e=>toast(e.message));});loadRooms().then(()=>{updateStatus();loadSleep();pollQueueImport();});setInterval(()=>{if(!document.hidden)updateStatus();},5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){updateStatus();pollQueueImport();}});setInterval(()=>{if(!document.hidden)loadSleep();},60000);
setInterval(()=>{updateProgress();renderSleep();},1000);

window.addEventListener('online',()=>{void updateStatus();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)rememberLibraryView();});
