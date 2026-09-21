import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beginQr,loadSession,pollQr,saveSession,sessionCookie,sessionState} from './qq-session.mjs';

const ip=process.env.SONOS_IP;
if(!ip)throw Error('请设置 SONOS_IP，例如 SONOS_IP=192.168.x.x npm start。');
const host=process.env.HOST||'0.0.0.0', port=Number(process.env.PORT||38473);
const base=`http://${ip}:1400`, dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const routes={AVTransport:'/MediaRenderer/AVTransport/Control',RenderingControl:'/MediaRenderer/RenderingControl/Control',GroupRenderingControl:'/MediaRenderer/GroupRenderingControl/Control',ContentDirectory:'/MediaServer/ContentDirectory/Control',ZoneGroupTopology:'/ZoneGroupTopology/Control'};
const enc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const dec=s=>String(s??'').replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,(_,n,v)=>n?String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n)):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[v.toLowerCase()]);
const tag=(xml,name)=>dec(new RegExp(`<(?:(?:[\\w-]+):)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${name}>`,'i').exec(xml)?.[1]||'');
const attr=(xml,name)=>dec(new RegExp(`\\b${name}="([^"]*)"`,'i').exec(xml)?.[1]||'');
async function soap(service,action,args={},target=base){
  const urn=`urn:schemas-upnp-org:service:${service}:1`;
  const data=`<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="${urn}">${Object.entries(args).map(([k,v])=>`<${k}>${enc(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const r=await fetch(target+routes[service],{method:'POST',headers:{'Content-Type':'text/xml; charset="utf-8"',SOAPACTION:`"${urn}#${action}"`},body:data,signal:AbortSignal.timeout(10000)});
  const x=await r.text(); if(!r.ok||x.includes('<s:Fault>'))throw Error(`${action} 失败：${tag(x,'errorDescription')||r.status}`); return x;
}
async function topology(){
  const description=await (await fetch(base+'/xml/device_description.xml',{signal:AbortSignal.timeout(5000)})).text();
  const udn=tag(description,'UDN').replace(/^uuid:/i,''), state=tag(await soap('ZoneGroupTopology','GetZoneGroupState'),'ZoneGroupState');
  const rooms=[];
  for(const match of state.matchAll(/<ZoneGroup\b[^>]*>[^]*?<\/ZoneGroup>/g)){
    const group=match[0],groupId=attr(group,'ID'),coordinatorId=attr(group,'Coordinator');
    for(const item of group.matchAll(/<ZoneGroupMember\b[^>]*>/g)){
      const member=item[0],id=attr(member,'UUID'),location=attr(member,'Location');
      if(!id||!location||attr(member,'Invisible')==='1')continue;
      rooms.push({id,name:attr(member,'ZoneName')||'Sonos',groupId,coordinatorId,device:new URL(location).origin});
    }
  }
  if(!rooms.some(room=>room.id===udn))throw Error('找不到当前 Sonos 房间。');
  return {rooms,defaultId:udn,defaultModel:tag(description,'modelName')||'Sonos'};
}
async function coordinator(roomId){
  const state=await topology(),selected=state.rooms.find(room=>room.id===(roomId||state.defaultId));
  if(!selected)throw Error('所选 Sonos 房间不存在，请刷新房间列表。');
  const leader=state.rooms.find(room=>room.id===selected.coordinatorId);
  if(!leader)throw Error('找不到 Sonos 分组的主音箱。');
  return {target:leader.device,device:selected.device,room:selected.name,roomId:selected.id,groupId:selected.groupId,coordinatorId:leader.id,groupSize:state.rooms.filter(room=>room.groupId===selected.groupId).length,model:selected.id===state.defaultId?state.defaultModel:'Sonos',rooms:state.rooms};
}
async function browse(id,start=0,count=200,target=base){
  const x=await soap('ContentDirectory','Browse',{ObjectID:id,BrowseFlag:'BrowseDirectChildren',Filter:'*',StartingIndex:start,RequestedCount:count,SortCriteria:''},target);
  return {xml:tag(x,'Result'),total:Number(tag(x,'TotalMatches'))};
}
const items=x=>[...x.matchAll(/<item\b[^>]*>[\s\S]*?<\/item>/g)].map(m=>m[0]);
let cached;
const lyricsCache=new Map();
const albumMidCache=new Map();
await loadSession();
async function playlist(refresh=false){
  if(cached&&!refresh&&Date.now()-cached.at<1800000)return cached;
  const fav=items((await browse('FV:2',0,500)).xml).find(x=>tag(x,'title').includes('我喜欢')&&x.includes('PLAYLIST_FAV'));
  const id=fav&&/PLAYLIST_FAV(?:%3[aA]|:)(\d+)/.exec(fav)?.[1]; if(!id)throw Error('Sonos 收藏中未找到 QQ 音乐“我喜欢”歌单。');
  const url=new URL('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg');
  const loginUin=/(?:^|;)\s*uin=o?(\d+)/.exec(sessionCookie())?.[1]||'0';
  url.search=new URLSearchParams({type:'1',json:'1',utf8:'1',onlysong:'0',disstid:id,format:'json',g_tk:'5381',loginUin,hostUin:'0',inCharset:'utf8',outCharset:'utf-8',platform:'yqq',needNewCode:'0'}).toString();
  const headers={Referer:'https://y.qq.com/'};if(sessionCookie())headers.Cookie=sessionCookie();
  const r=await fetch(url,{headers,signal:AbortSignal.timeout(15000)}); if(!r.ok)throw Error(`QQ 音乐请求失败：${r.status}`);
  const data=await r.json(); if(data.code!==0||!Array.isArray(data.cdlist?.[0]?.songlist))throw Error('QQ 音乐没有返回可用的歌单数据。请在 Mac 上重新登录后重试。');
  const songs=data.cdlist[0].songlist.map((s,i)=>({index:i+1,id:Number(s.songid||s.id),mid:String(s.songmid||s.mid||''),title:s.songname||s.name||'',artist:(s.singer||[]).map(a=>a.name).join('、'),album:s.albumname||'',albumMid:String(s.albummid||s.album?.mid||''),duration:Number(s.interval||0)})).filter(s=>s.id&&s.mid);
  cached={id,title:'我喜欢',songs,at:Date.now()}; return cached;
}
async function qqAlbumMid(id){
  const previous=albumMidCache.get(id);
  if(previous&&Date.now()-previous.at<1800000)return previous.mid;
  const url=new URL('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg');
  url.search=new URLSearchParams({songid:id,tpl:'yqq_song_detail',format:'json'}).toString();
  const response=await fetch(url,{headers:{Referer:'https://y.qq.com/'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error(`专辑信息请求失败：${response.status}`);
  const mid=String((await response.json()).data?.[0]?.album?.mid||'');
  albumMidCache.set(id,{mid,at:Date.now()});
  if(albumMidCache.size>200)albumMidCache.delete(albumMidCache.keys().next().value);
  return mid;
}
function parseLyrics(source){
  const lines=[];
  for(const row of String(source||'').split(/\r?\n/)){
    const stamps=[...row.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text=dec(row.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g,'').replace(/<\d+,\d+,\d+>/g,'').trim());
    if(!text)continue;
    for(const stamp of stamps){
      const fraction=stamp[3]?Number(stamp[3].padEnd(3,'0'))/1000:0;
      lines.push({time:Number(stamp[1])*60+Number(stamp[2])+fraction,text});
    }
  }
  return lines.sort((a,b)=>a.time-b.time).slice(0,500);
}
async function lyricsForSong(id){
  const cachedLyrics=lyricsCache.get(id);
  if(cachedLyrics&&Date.now()-cachedLyrics.at<1800000)return cachedLyrics.data;
  let mid=cached?.songs.find(song=>song.id===Number(id))?.mid;
  const headers={Referer:'https://y.qq.com/'};
  if(sessionCookie())headers.Cookie=sessionCookie();
  if(!mid){
    const detail=new URL('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg');
    detail.search=new URLSearchParams({songid:id,tpl:'yqq_song_detail',format:'json'}).toString();
    const response=await fetch(detail,{headers,signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error(`歌曲信息请求失败：${response.status}`);
    mid=(await response.json()).data?.[0]?.mid;
  }
  if(!mid)throw Error('当前歌曲没有可用的歌词信息。');
  const url=new URL('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg');
  url.search=new URLSearchParams({songmid:mid,format:'json',nobase64:'1',g_tk:'5381',loginUin:'0',hostUin:'0',inCharset:'utf8',outCharset:'utf-8',platform:'yqq',needNewCode:'0'}).toString();
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error(`歌词请求失败：${response.status}`);
  const result=await response.json();
  if(result.code!==0)throw Error('当前歌曲的歌词暂不可用。');
  let raw=String(result.lyric||'');
  if(!raw.includes('[')&&/^[A-Za-z0-9+/=\s]+$/.test(raw))raw=Buffer.from(raw,'base64').toString('utf8');
  const data={songId:Number(id),lines:parseLyrics(raw)};
  lyricsCache.set(id,{at:Date.now(),data});
  if(lyricsCache.size>200)lyricsCache.delete(lyricsCache.keys().next().value);
  return data;
}
async function queueTrack(target,id){
  let first=await browse('Q:0',0,200,target);
  for(let start=0;start<first.total;start+=200){
    const page=start?await browse('Q:0',start,200,target):first;
    for(const item of items(page.xml))if(new RegExp(`SONG(?:%3[aA]|:)${id}(?:(?:%3[aA]|:)|\\.)`).test(item)){
      const number=/Q:0\/(\d+)/.exec(attr(item,'id'))?.[1]; if(number)return number;
    }
  }
  return null;
}
async function enqueueSong(target,song,asNext){
    const fav=items((await browse('FV:2',0,500)).xml).find(x=>tag(x,'title').includes('我喜欢')&&x.includes('PLAYLIST_FAV'));
    const res=fav&&tag(fav,'res'), sid=/[?&]sid=(\d+)/.exec(res)?.[1]||'23';
    const queueSample=(await browse('Q:0',0,1,target)).xml;
    const sn=/x-sonos-http:[^<]*[?&]sn=(\d+)/.exec(queueSample)?.[1]||'6';
    const uri=`x-sonos-http:SONG%3a${song.id}%3aST.mp4?sid=${sid}&flags=8232&sn=${sn}`;
    const metadata=`<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="SONG:${song.id}:ST" parentID="" restricted="true"><dc:title>${enc(song.title)}</dc:title><dc:creator>${enc(song.artist)}</dc:creator><upnp:album>${enc(song.album)}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="sonos.com-http:*:audio/mp4:*">${enc(uri)}</res></item></DIDL-Lite>`;
    const number=tag(await soap('AVTransport','AddURIToQueue',{InstanceID:0,EnqueuedURI:uri,EnqueuedURIMetaData:metadata,DesiredFirstTrackNumberEnqueued:0,EnqueueAsNext:asNext?1:0},target),'FirstTrackNumberEnqueued');
    if(!number||number==='0')throw Error('已添加到队列，但 Sonos 未返回曲目位置。');
    return Number(number);
}
async function songByMid(mid){const list=await playlist(),song=list.songs.find(s=>s.mid===mid);if(!song)throw Error('歌曲不在当前歌单中，请刷新歌单。');return song;}
async function playSong(mid,roomId){
  const song=await songByMid(mid),{target}=await coordinator(roomId);
  let number=await queueTrack(target,song.id);
  if(!number)number=await enqueueSong(target,song,false);
  await soap('AVTransport','Seek',{InstanceID:0,Unit:'TRACK_NR',Target:number},target);
  await soap('AVTransport','Play',{InstanceID:0,Speed:1},target);
  return {title:song.title,artist:song.artist,queueNumber:Number(number)};
}
async function addSongToQueue(mid,placement,roomId){
  if(!['next','end'].includes(placement))throw Error('加入队列的位置无效。');
  const song=await songByMid(mid),{target}=await coordinator(roomId);
  const number=await enqueueSong(target,song,placement==='next');
  return {title:song.title,number};
}
async function queuePage(start=0,roomId){
  const {target}=await coordinator(roomId);
  let page=await browse('Q:0',start,100,target);
  if(page.total&&start>=page.total){start=Math.floor((page.total-1)/100)*100;page=await browse('Q:0',start,100,target);}
  let songLookup=new Map(cached?.songs.map(song=>[song.id,song])||[]);
  if(!songLookup.size){try{songLookup=new Map((await playlist()).songs.map(song=>[song.id,song]));}catch{}}
  const tracks=items(page.xml).map(item=>{
    const number=Number(/Q:0\/(\d+)/.exec(attr(item,'id'))?.[1]||0);
    const songId=Number(/SONG(?:%3[aA]|:)(\d+)(?:(?:%3[aA]|:)|\.)/.exec(tag(item,'res'))?.[1]||0);
    const song=songLookup.get(songId);
    return {number,songId,title:tag(item,'title')||song?.title||'未知歌曲',artist:tag(item,'creator')||song?.artist||'',album:tag(item,'album')||song?.album||''};
  }).filter(track=>track.number);
  return {tracks,total:page.total,start};
}
async function playQueueTrack(number,roomId){
  if(!Number.isInteger(number)||number<1||number>10000)throw Error('队列位置无效。');
  const {target}=await coordinator(roomId);
  const page=await browse('Q:0',number-1,1,target);
  if(!items(page.xml).some(item=>Number(/Q:0\/(\d+)/.exec(attr(item,'id'))?.[1])===number))throw Error('该歌曲已不在队列中，请刷新队列。');
  await soap('AVTransport','Seek',{InstanceID:0,Unit:'TRACK_NR',Target:number},target);
  await soap('AVTransport','Play',{InstanceID:0,Speed:1},target);
}
async function editQueue(input,roomId){
  const number=Number(input.number),{target}=await coordinator(roomId);
  if(!Number.isInteger(number)||number<1||number>10000)throw Error('队列位置无效。');
  const page=await browse('Q:0',number-1,1,target),item=items(page.xml)[0];
  if(!item||Number(/Q:0\/(\d+)/.exec(attr(item,'id'))?.[1])!==number)throw Error('队列已变化，请刷新后重试。');
  const actualId=Number(/SONG(?:%3[aA]|:)(\d+)(?:(?:%3[aA]|:)|\.)/.exec(tag(item,'res'))?.[1]||0);
  if(input.songId!=null&&Number(input.songId)!==actualId)throw Error('队列已变化，请刷新后重试。');
  if(input.action==='remove')await soap('AVTransport','RemoveTrackFromQueue',{InstanceID:0,ObjectID:`Q:0/${number}`,UpdateID:0},target);
  else if(input.action==='move'){
    const before=Number(input.before);
    if(!Number.isInteger(before)||before<1||before>page.total+1)throw Error('目标位置无效。');
    if(before===number||before===number+1)return;
    await soap('AVTransport','ReorderTracksInQueue',{InstanceID:0,StartingIndex:number,NumberOfTracks:1,InsertBefore:before,UpdateID:0},target);
  }else throw Error('未知队列操作。');
}
async function sleepStatus(roomId){
  const {target}=await coordinator(roomId);
  const result=await soap('AVTransport','GetRemainingSleepTimerDuration',{InstanceID:0},target);
  const value=tag(result,'RemainingSleepTimerDuration');
  const match=/^(\d+):(\d{2}):(\d{2})$/.exec(value);
  const remaining=match?Number(match[1])*3600+Number(match[2])*60+Number(match[3]):0;
  return {remaining,endsAt:remaining?new Date(Date.now()+remaining*1000).toISOString():null};
}
async function setSleepTimer(input,roomId){
  let seconds=0;
  if(input.mode==='minutes'){
    const minutes=Number(input.minutes);
    if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('请输入 1 到 1440 分钟。');
    seconds=minutes*60;
  }else if(input.mode==='until'){
    const at=Date.parse(input.at);
    if(!Number.isFinite(at))throw Error('停止时间无效。');
    seconds=Math.ceil((at-Date.now())/1000);
    if(seconds<1||seconds>86400)throw Error('请选择未来 24 小时内的时间。');
  }else if(input.mode!=='cancel')throw Error('定时方式无效。');
  const value=seconds?`${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:'';
  const {target}=await coordinator(roomId);
  await soap('AVTransport','ConfigureSleepTimer',{InstanceID:0,NewSleepTimerDuration:value},target);
  return sleepStatus(roomId);
}
async function roomList(){
  const state=await topology();
  const rooms=await Promise.all(state.rooms.map(async room=>{
    let volume=null;
    try{volume=Number(tag(await soap('RenderingControl','GetVolume',{InstanceID:0,Channel:'Master'},room.device),'CurrentVolume'));}catch{}
    return {id:room.id,name:room.name,groupId:room.groupId,coordinatorId:room.coordinatorId,volume};
  }));
  return {rooms,defaultId:state.defaultId};
}
async function setGroup(input){
  const state=await topology(),room=state.rooms.find(item=>item.id===input.roomId);
  if(!room)throw Error('所选房间不存在。');
  if(input.action==='join'){
    const target=state.rooms.find(item=>item.id===input.targetId);
    if(!target||target.id===room.id)throw Error('目标房间无效。');
    if(room.groupId===target.groupId)return;
    if(room.coordinatorId===room.id&&state.rooms.filter(item=>item.groupId===room.groupId).length>1)throw Error('请先将该主音箱的其他房间移出分组。');
    await soap('AVTransport','SetAVTransportURI',{InstanceID:0,CurrentURI:`x-rincon:${target.coordinatorId}`,CurrentURIMetaData:''},room.device);
  }else if(input.action==='leave'){
    if(state.rooms.filter(item=>item.groupId===room.groupId).length===1)return;
    if(room.coordinatorId===room.id)throw Error('请从组内其他房间执行移出操作。');
    await soap('AVTransport','BecomeCoordinatorOfStandaloneGroup',{InstanceID:0},room.device);
  }else throw Error('未知分组操作。');
}
async function status(roomId){
  const {target,device,room,roomId:selectedRoomId,groupSize,model}=await coordinator(roomId);
  const [transport,position,settings,crossfade,volume,mute,groupVolume]=await Promise.all([
    soap('AVTransport','GetTransportInfo',{InstanceID:0},target),soap('AVTransport','GetPositionInfo',{InstanceID:0},target),
    soap('AVTransport','GetTransportSettings',{InstanceID:0},target),soap('AVTransport','GetCrossfadeMode',{InstanceID:0},target),
    soap('RenderingControl','GetVolume',{InstanceID:0,Channel:'Master'},device),soap('RenderingControl','GetMute',{InstanceID:0,Channel:'Master'},device),
    groupSize>1?soap('GroupRenderingControl','GetGroupVolume',{InstanceID:0},target):Promise.resolve('')]);
  const metadata=tag(position,'TrackMetaData'), mode=tag(settings,'PlayMode');
  const art=tag(metadata,'albumArtURI');
  let albumArt=null;
  if(art){try{const url=new URL(art,target);if(url.origin===target)albumArt=`/api/art?room=${encodeURIComponent(selectedRoomId)}&uri=${encodeURIComponent(url.pathname+url.search)}`;}catch{}}
  const uri=tag(position,'TrackURI'),songId=Number(/SONG(?:%3[aA]|:)(\d+)(?:(?:%3[aA]|:)|\.)/.exec(uri)?.[1]||0);
  let title=tag(metadata,'title'),artist=tag(metadata,'creator'),album=tag(metadata,'album'),duration=tag(position,'TrackDuration');
  if(songId&&(!title||!artist||!albumArt||!duration||duration==='0:00:00')){
    let song=cached?.songs.find(s=>s.id===songId);
    if(!song){try{song=(await playlist()).songs.find(s=>s.id===songId);}catch{}}
    if(song){
      title||=song.title;artist||=song.artist;album||=song.album;
      if((!duration||duration==='0:00:00')&&song.duration)duration=`${Math.floor(song.duration/3600)}:${String(Math.floor(song.duration/60)%60).padStart(2,'0')}:${String(song.duration%60).padStart(2,'0')}`;
      if(!albumArt){
        let albumMid=song.albumMid;
        if(!/^[A-Za-z0-9]{14}$/.test(albumMid)){
          try{albumMid=await qqAlbumMid(songId);}catch{}
        }
        if(/^[A-Za-z0-9]{14}$/.test(albumMid))albumArt=`/api/qq/art?mid=${albumMid}`;
      }
    }
  }
  return {room,roomId:selectedRoomId,groupSize,model,ip,playing:tag(transport,'CurrentTransportState')==='PLAYING',state:tag(transport,'CurrentTransportState'),volume:Number(tag(volume,'CurrentVolume')),groupVolume:groupSize>1?Number(tag(groupVolume,'CurrentVolume')):null,mute:tag(mute,'CurrentMute')==='1',shuffle:mode.startsWith('SHUFFLE'),repeatOne:['REPEAT_ONE','SHUFFLE_REPEAT_ONE'].includes(mode),repeatAll:['REPEAT_ALL','SHUFFLE'].includes(mode),crossfade:tag(crossfade,'CrossfadeMode')==='1',playMode:mode,title,artist,album,albumArt,songId,track:Number(tag(position,'Track')),position:tag(position,'RelTime'),duration};
}
async function control(action,value,roomId){
  const {target,device,groupSize}=await coordinator(roomId), transport=(name,args={})=>soap('AVTransport',name,{InstanceID:0,...args},target);
  if(action==='play')await transport('Play',{Speed:1}); else if(action==='pause')await transport('Pause');
  else if(action==='next')await transport('Next'); else if(action==='previous')await transport('Previous');
  else if(action==='volume'||action==='groupVolume'){
    const n=Number(value);if(!Number.isInteger(n)||n<0||n>100)throw Error('音量必须在 0–100 之间。');
    if(action==='groupVolume'){if(groupSize<2)throw Error('当前房间没有分组。');await soap('GroupRenderingControl','SetGroupVolume',{InstanceID:0,DesiredVolume:n},target);}
    else await soap('RenderingControl','SetVolume',{InstanceID:0,Channel:'Master',DesiredVolume:n},device);
  }
  else if(action==='mute')await soap('RenderingControl','SetMute',{InstanceID:0,Channel:'Master',DesiredMute:value?1:0},device);
  else if(action==='crossfade'){if(typeof value!=='boolean')throw Error('淡入淡出值无效。');await transport('SetCrossfadeMode',{CrossfadeMode:value?1:0});}
  else if(action==='seek'){
    const seconds=Number(value);
    if(!Number.isInteger(seconds)||seconds<0||seconds>86400)throw Error('播放位置无效。');
    const targetTime=`${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    await transport('Seek',{Unit:'REL_TIME',Target:targetTime});
  }
  else if(action==='shuffle'||action==='repeatOne'||action==='repeatAll'){
    if(typeof value!=='boolean')throw Error('播放模式值无效。');
    const mode=tag(await transport('GetTransportSettings'),'PlayMode');
    const shuffled=mode.startsWith('SHUFFLE');
    const repeat=['REPEAT_ALL','SHUFFLE'].includes(mode)?'all':['REPEAT_ONE','SHUFFLE_REPEAT_ONE'].includes(mode)?'one':'none';
    const nextShuffle=action==='shuffle'?value:shuffled;
    const nextRepeat=action==='repeatOne'?(value?'one':'none'):action==='repeatAll'?(value?'all':'none'):repeat;
    const modes=nextShuffle?{none:'SHUFFLE_NOREPEAT',all:'SHUFFLE',one:'SHUFFLE_REPEAT_ONE'}:{none:'NORMAL',all:'REPEAT_ALL',one:'REPEAT_ONE'};
    await transport('SetPlayMode',{NewPlayMode:modes[nextRepeat]});
  }else throw Error('未知控制命令。');
}
const send=(res,code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function requestBody(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)throw Error('请求太大。');}return JSON.parse(raw||'{}');}
const isLocal=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const localWrite=req=>isLocal(req)&&(!req.headers.origin||[`http://localhost:${port}`,`http://127.0.0.1:${port}`].includes(req.headers.origin));
http.createServer(async(req,res)=>{try{
  const requestUrl=new URL(req.url,`http://${req.headers.host||'localhost'}`),pathname=requestUrl.pathname,roomId=requestUrl.searchParams.get('room')||undefined;
  if(req.method==='GET'&&pathname==='/api/status')return send(res,200,await status(roomId));
  if(req.method==='GET'&&pathname==='/api/rooms')return send(res,200,await roomList());
  if(req.method==='POST'&&pathname==='/api/rooms/group'){await setGroup(await requestBody(req));return send(res,200,await roomList());}
  if(req.method==='GET'&&pathname==='/api/queue'){
    const start=Number(requestUrl.searchParams.get('start')||0);
    if(!Number.isInteger(start)||start<0||start>10000)return send(res,400,{error:'队列位置无效。'});
    return send(res,200,await queuePage(start,roomId));
  }
  if(req.method==='POST'&&pathname==='/api/queue/play'){
    const body=await requestBody(req);await playQueueTrack(Number(body.number),roomId);return send(res,200,{ok:true});
  }
  if(req.method==='POST'&&pathname==='/api/queue/edit'){await editQueue(await requestBody(req),roomId);return send(res,200,{ok:true});}
  if(req.method==='POST'&&pathname==='/api/queue/add'){
    const body=await requestBody(req);return send(res,200,{ok:true,...await addSongToQueue(String(body.mid||''),body.placement,roomId)});
  }
  if(req.method==='GET'&&pathname==='/api/sleep')return send(res,200,await sleepStatus(roomId));
  if(req.method==='POST'&&pathname==='/api/sleep')return send(res,200,await setSleepTimer(await requestBody(req),roomId));
  if(req.method==='GET'&&pathname==='/api/lyrics'){
    const id=new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.get('id')||'';
    if(!/^\d{1,12}$/.test(id))return send(res,400,{error:'歌曲 ID 无效。'});
    return send(res,200,await lyricsForSong(id));
  }
  if(req.method==='GET'&&pathname==='/api/art'){
    const {target}=await coordinator(roomId),uri=requestUrl.searchParams.get('uri')||'';
    const url=new URL(uri,target);
    if(!uri.startsWith('/')||uri.startsWith('//')||url.origin!==target)return send(res,400,{error:'封面地址无效。'});
    const image=await fetch(url,{signal:AbortSignal.timeout(10000)});
    if(!image.ok)throw Error(`封面获取失败：${image.status}`);
    const type=image.headers.get('content-type')||'';
    if(!type.startsWith('image/'))throw Error('封面格式无效。');
    const data=Buffer.from(await image.arrayBuffer());
    if(data.length>5_000_000)throw Error('封面文件过大。');
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'private, max-age=3600'});res.end(data);return;
  }
  if(req.method==='GET'&&pathname==='/api/qq/art'){
    const mid=new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.get('mid')||'';
    if(!/^[A-Za-z0-9]{14}$/.test(mid))return send(res,400,{error:'专辑封面 ID 无效。'});
    const image=await fetch(`https://y.qq.com/music/photo_new/T002R300x300M000${mid}.jpg`,{signal:AbortSignal.timeout(10000)});
    if(!image.ok)throw Error(`专辑封面获取失败：${image.status}`);
    const type=image.headers.get('content-type')||'';
    if(!type.startsWith('image/'))throw Error('专辑封面格式无效。');
    const data=Buffer.from(await image.arrayBuffer());
    if(data.length>5_000_000)throw Error('专辑封面文件过大。');
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'private, max-age=3600'});res.end(data);return;
  }
  if(req.method==='GET'&&pathname==='/api/qq/session')return send(res,200,{...sessionState(),local:isLocal(req)});
  if(pathname.startsWith('/api/qq/login/')&&!localWrite(req))return send(res,403,{error:'请在 Mac 本机打开 localhost 登录 QQ 音乐。'});
  if(req.method==='POST'&&pathname==='/api/qq/login/qr')return send(res,200,await beginQr());
  if(req.method==='GET'&&pathname==='/api/qq/login/poll')return send(res,200,await pollQr());
  if(req.method==='POST'&&pathname==='/api/qq/login/cookie'){const b=await requestBody(req);await saveSession(b.cookie);cached=null;return send(res,200,{ok:true});}
  if(req.method==='GET'&&pathname==='/api/playlist'){const p=await playlist(new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.has('refresh'));return send(res,200,{id:p.id,title:p.title,songs:p.songs,updatedAt:new Date(p.at).toISOString()});}
  if(req.method==='POST'&&pathname==='/api/control'){const b=await requestBody(req);await control(b.action,b.value,roomId);return send(res,200,{ok:true});}
  if(req.method==='POST'&&pathname==='/api/play'){const b=await requestBody(req);return send(res,200,{ok:true,...await playSong(String(b.mid||''),roomId)});}
  const file=pathname==='/'?'index.html':pathname.slice(1);if(req.method!=='GET'||!['index.html','app.js','style.css'].includes(file))return send(res,404,{error:'页面不存在。'});
  const contents=await readFile(path.join(dir,file));res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}[path.extname(file)]});res.end(contents);
}catch(e){console.error(e);send(res,500,{error:e.message||'服务出错。'});}}).listen(port,host,()=>console.log(`Sonos web http://${host}:${port}; Sonos ${ip}`));
