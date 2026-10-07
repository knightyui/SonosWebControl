import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beginQr,loadSession,pollQr,saveSelectedPlaylist,saveSession,selectSession,selectedPlaylist,sessionCookie,sessionState} from './qq-session.mjs';
import {clearPlayHistory,loadPlayHistory,recentPlays,recordPlay} from './play-history.mjs';
import {assertQueueTrack,createKeyedMutationQueue,matchPlaylistQueue,remainingPlaylistIndices,replaceQueueSafely,replaceQueueTailSafely,requiresQueueRecheck,shuffledIndices,withoutSonosShuffle} from './queue-safety.mjs';
import {hasMoreSearchResults,parseSearchPage,searchPageSize} from './search-pagination.mjs';
import {createSonosLocator} from './sonos-discovery.mjs';

const locator=createSonosLocator({seedIp:process.env.SONOS_IP||''});
const host=process.env.HOST||'0.0.0.0', port=Number(process.env.PORT||38473);
const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const routes={AVTransport:'/MediaRenderer/AVTransport/Control',RenderingControl:'/MediaRenderer/RenderingControl/Control',GroupRenderingControl:'/MediaRenderer/GroupRenderingControl/Control',ContentDirectory:'/MediaServer/ContentDirectory/Control',ZoneGroupTopology:'/ZoneGroupTopology/Control'};
const enc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const dec=s=>String(s??'').replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,(_,n,v)=>n?String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n)):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[v.toLowerCase()]);
const tag=(xml,name)=>dec(new RegExp(`<(?:(?:[\\w-]+):)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${name}>`,'i').exec(xml)?.[1]||'');
const attr=(xml,name)=>dec(new RegExp(`\\b${name}="([^"]*)"`,'i').exec(xml)?.[1]||'');
async function soap(service,action,args={},target){
  target??=(await locator.resolve()).origin;
  const urn=`urn:schemas-upnp-org:service:${service}:1`;
  const data=`<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="${urn}">${Object.entries(args).map(([k,v])=>`<${k}>${enc(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const r=await fetch(target+routes[service],{method:'POST',headers:{'Content-Type':'text/xml; charset="utf-8"',SOAPACTION:`"${urn}#${action}"`},body:data,signal:AbortSignal.timeout(10000)});
  const x=await r.text(); if(!r.ok||x.includes('<s:Fault>'))throw Error(`${action} 失败：${tag(x,'errorDescription')||r.status}`); return x;
}
async function topology(refresh=false){
  const device=await locator.resolve(refresh);
  try{return await topologyFor(device);}catch(error){
    locator.invalidate(device.origin);
    if(refresh)throw error;
    return topologyFor(await locator.resolve(true));
  }
}
async function topologyFor({origin,description}){
  const udn=tag(description,'UDN').replace(/^uuid:/i,''), state=tag(await soap('ZoneGroupTopology','GetZoneGroupState',{},origin),'ZoneGroupState');
  const rooms=[];
  for(const match of state.matchAll(/<ZoneGroup\b[^>]*>[^]*?<\/ZoneGroup>/g)){
    const group=match[0],groupId=attr(group,'ID'),coordinatorId=attr(group,'Coordinator');
    for(const item of group.matchAll(/<ZoneGroupMember\b[^>]*>/g)){
      const member=item[0],id=attr(member,'UUID'),location=attr(member,'Location');
      if(!id||!location||attr(member,'Invisible')==='1')continue;
      rooms.push({id,name:attr(member,'ZoneName')||'Sonos',groupId,coordinatorId,device:new URL(location).origin});
    }
  }
  if(!rooms.length)throw Error('找不到当前 Sonos 房间。');
  const visiblePrimary=rooms.some(room=>room.id===udn);
  return {rooms,defaultId:visiblePrimary?udn:rooms[0].id,defaultModel:visiblePrimary?(tag(description,'modelName')||'Sonos'):'Sonos'};
}
async function coordinator(roomId){
  const state=await topology(),selected=state.rooms.find(room=>room.id===(roomId||state.defaultId));
  if(!selected)throw Error('所选 Sonos 房间不存在，请刷新房间列表。');
  const leader=state.rooms.find(room=>room.id===selected.coordinatorId);
  if(!leader)throw Error('找不到 Sonos 分组的主音箱。');
  return {target:leader.device,device:selected.device,room:selected.name,roomId:selected.id,groupId:selected.groupId,coordinatorId:leader.id,groupSize:state.rooms.filter(room=>room.groupId===selected.groupId).length,model:selected.id===state.defaultId?state.defaultModel:'Sonos',rooms:state.rooms};
}
async function browse(id,start=0,count=200,target){
  const x=await soap('ContentDirectory','Browse',{ObjectID:id,BrowseFlag:'BrowseDirectChildren',Filter:'*',StartingIndex:start,RequestedCount:count,SortCriteria:''},target);
  return {xml:tag(x,'Result'),total:Number(tag(x,'TotalMatches')),updateId:tag(x,'UpdateID')};
}
const items=x=>[...x.matchAll(/<item\b[^>]*>[\s\S]*?<\/item>/g)].map(m=>m[0]);
const songIdFromUri=uri=>Number(/SONG(?:%3[aA]|:)(\d+)(?:(?:%3[aA]|:)|\.)/.exec(uri)?.[1]||0);
const songIdFromItem=item=>songIdFromUri(tag(item,'res'));
const queueItemNumber=item=>Number(/Q:0\/(\d+)/.exec(attr(item,'id'))?.[1]||0);
const queueItemKey=item=>createHash('sha256').update([tag(item,'res'),tag(item,'title'),tag(item,'creator')].join('\0')).digest('hex').slice(0,24);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let cached;
let selectedPlaylistId='liked';
let playlistCatalog;
const catalogLoads=new Map(),playlistLoads=new Map();
const lyricsCache=new Map();
const albumMidCache=new Map();
const searchedSongs=new Map();
const searchedSongById=id=>[...searchedSongs.values()].find(song=>song.id===Number(id));
await loadSession();
await loadPlayHistory();
selectedPlaylistId=selectedPlaylist();
const historyAccount=()=>sessionState().active||'local';
const qqUin=()=>{const value=sessionCookie(),uin=/(?:^|;)\s*uin=o?(\d+)/.exec(value)?.[1];return uin&&uin!=='0'?uin:/(?:^|;)\s*wxuin=(\d+)/.exec(value)?.[1]||uin||'0';};
const qqHeaders=()=>({Referer:'https://y.qq.com/',...(sessionCookie()?{Cookie:sessionCookie()}:{})});
async function qqGet(endpoint,params){
  const url=new URL(endpoint);url.search=new URLSearchParams({...params,format:'json',g_tk:'5381',loginUin:qqUin(),hostUin:'0',inCharset:'utf8',outCharset:'utf-8',platform:'yqq'}).toString();
  const response=await fetch(url,{headers:qqHeaders(),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`QQ 音乐请求失败：${response.status}`);
  return response.json();
}
async function playlistPage(id,start,count){
  const response=await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg',{method:'POST',headers:{...qqHeaders(),'Content-Type':'application/json'},body:JSON.stringify({comm:{ct:24,cv:4747474,platform:'yqq.json',uin:qqUin(),g_tk:5381,format:'json'},req_0:{module:'music.srfDissInfo.DissInfo',method:'CgiGetDiss',param:{disstid:id==='liked'?0:Number(id),dirid:id==='liked'?201:0,tag:true,song_begin:start,song_num:count,userinfo:true,orderlist:true}}}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`QQ 音乐请求失败：${response.status}`);
  const result=(await response.json()).req_0;
  if(result?.code!==0||result.data?.code!==0||!Array.isArray(result.data?.songlist))throw Error('QQ 音乐登录已失效，或当前歌单不可用。请重新登录。');
  return result.data;
}
async function playlists(refresh=false){
  const account=historyAccount();
  if(playlistCatalog?.account===account&&!refresh&&Date.now()-playlistCatalog.at<1800000)return playlistCatalog.list;
  if(catalogLoads.has(account))return catalogLoads.get(account);
  const pending=fetchPlaylists(account);
  catalogLoads.set(account,pending);
  try{return await pending;}finally{if(catalogLoads.get(account)===pending)catalogLoads.delete(account);}
}
async function fetchPlaylists(account){
  if(!sessionCookie())throw Error('请先在网页中登录 QQ 音乐。');
  const [liked,createdList,collectedList]=await Promise.all([
    playlistPage('liked',0,1),
    (async()=>{const result=[];for(let start=0;start<1000;start+=200){const page=await qqGet('https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss',{hostuin:qqUin(),sin:start,size:200});if(page.code!==0||!Array.isArray(page.data?.disslist))throw Error('QQ 音乐没有返回自建歌单。');result.push(...page.data.disslist);if(page.data.disslist.length<200)break;}return result;})(),
    (async()=>{const result=[];for(let start=0;start<1000;start+=200){const page=await qqGet('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg',{ct:20,cv:4747474,cid:205360956,userid:qqUin(),reqtype:3,sin:start,ein:start+199});if(page.code!==0||!Array.isArray(page.data?.cdlist))throw Error('QQ 音乐没有返回收藏歌单。');result.push(...page.data.cdlist);if(page.data.cdlist.length<200)break;}return result;})()
  ]);
  const list=[{id:'liked',title:'我喜欢',count:Number(liked.total_song_num||liked.dirinfo?.songnum||0),source:'liked'}];
  const seen=new Set(['liked']);
  for(const item of createdList){const id=String(item.tid||'');if(!/^\d+$/.test(id)||seen.has(id))continue;seen.add(id);list.push({id,title:item.diss_name||'未命名歌单',count:Number(item.song_cnt||0),source:'created'});}
  for(const item of collectedList){const id=String(item.dissid||'');if(!/^\d+$/.test(id)||seen.has(id))continue;seen.add(id);list.push({id,title:item.dissname||'未命名歌单',count:Number(item.songnum||0),source:'collected'});}
  if(account!==historyAccount())throw Error('QQ 账号已切换，请重试。');
  if(!list.some(item=>item.id===selectedPlaylistId)){selectedPlaylistId='liked';await saveSelectedPlaylist('liked');}
  playlistCatalog={account,list,at:Date.now()};return list;
}
const mapSong=(s,i)=>({index:i+1,id:Number(s.songid||s.id),mid:String(s.songmid||s.mid||''),title:s.title||s.songname||s.name||'',artist:(s.singer||[]).map(a=>a.name).join('、'),album:s.albumname||s.album?.name||'',albumMid:String(s.albummid||s.album?.mid||''),duration:Number(s.interval||0)});
async function playlist(refresh=false){
  const key=`${historyAccount()}:${selectedPlaylistId}`;
  if(playlistLoads.has(key))return playlistLoads.get(key);
  const pending=fetchPlaylist(refresh);
  playlistLoads.set(key,pending);
  try{return await pending;}finally{if(playlistLoads.get(key)===pending)playlistLoads.delete(key);}
}
async function fetchPlaylist(refresh=false){
  const account=historyAccount(),id=selectedPlaylistId;
  if(cached&&cached.account===account&&cached.id===id&&!refresh&&Date.now()-cached.at<1800000)return cached;
  const catalog=await playlists(refresh),entry=catalog.find(x=>x.id===id);
  if(!entry)throw Error('当前歌单不属于所选 QQ 音乐账号，请重新选择。');
  const first=await playlistPage(entry.id,0,200),total=Number(first.total_song_num||0),all=[...first.songlist];
  for(let start=all.length;start<total&&start<10000;start+=200){const page=await playlistPage(entry.id,start,200);if(!page.songlist.length)break;all.push(...page.songlist);}
  const songs=all.map(mapSong).filter(s=>s.id&&s.mid);
  if(account!==historyAccount()||id!==selectedPlaylistId)throw Error('歌单已切换，请重试。');
  cached={account,id:entry.id,title:entry.title,songs,at:Date.now()};return cached;
}
async function searchSongs(query,pageInput){
  const q=String(query||'').trim();if(q.length<2||q.length>80)throw Error('请输入 2 到 80 个字搜索歌曲。');
  const page=parseSearchPage(pageInput);
  const response=await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg',{method:'POST',headers:{'Content-Type':'application/json',Referer:'https://y.qq.com/'},body:JSON.stringify({req_0:{module:'music.search.SearchCgiService',method:'DoSearchForQQMusicDesktop',param:{search_type:0,query:q,page_num:page,num_per_page:searchPageSize}}}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`QQ 音乐搜索失败：${response.status}`);
  const block=(await response.json()).req_0;
  if(block?.code!==0||block.data?.code!==0||!Array.isArray(block.data?.body?.song?.list))throw Error('QQ 音乐搜索暂不可用。');
  const songs=block.data.body.song.list.map(mapSong).filter(song=>song.id&&song.mid);
  for(const song of songs)searchedSongs.set(song.mid,{...song,at:Date.now()});
  // Keep paged results playable after the user has browsed beyond the first few pages.
  while(searchedSongs.size>30000)searchedSongs.delete(searchedSongs.keys().next().value);
  const total=Number(block.data.meta?.sum);
  return {songs,total:Number.isFinite(total)&&total>0?total:null,page,hasMore:hasMoreSearchResults(page,total,block.data.body.song.list.length)};
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
function decodeLyrics(value){
  let raw=String(value||'');
  if(raw&&!raw.includes('[')&&/^[A-Za-z0-9+/=\s]+$/.test(raw))raw=Buffer.from(raw,'base64').toString('utf8');
  return raw;
}
function addTranslations(lines,translations){
  let next=0;
  return lines.map(line=>{
    while(next<translations.length&&translations[next].time<line.time-.6)next++;
    if(next<translations.length&&Math.abs(translations[next].time-line.time)<=.6){
      const translation=translations[next++].text;
      if(translation&&translation!==line.text)return {...line,translation};
    }
    return line;
  });
}
async function lyricsForSong(id){
  const cachedLyrics=lyricsCache.get(id);
  if(cachedLyrics&&Date.now()-cachedLyrics.at<1800000)return cachedLyrics.data;
  let mid=cached?.songs.find(song=>song.id===Number(id))?.mid||searchedSongById(id)?.mid;
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
  // The legacy endpoint often omits translations unless they are explicitly
  // requested. The current PlayLyricInfo endpoint supports trans: 1.
  let lines=[],translations=[];
  try{
    const response=await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg',{
      method:'POST',headers:{'Content-Type':'application/json',Referer:'https://y.qq.com/'},
      body:JSON.stringify({comm:{ct:24,cv:0},lyric:{module:'music.musichallSong.PlayLyricInfo',method:'GetPlayLyricInfo',param:{songMID:mid,songID:Number(id),trans:1}}}),
      signal:AbortSignal.timeout(10000)
    });
    if(response.ok){
      const block=(await response.json()).lyric;
      if(block?.code===0){
        lines=parseLyrics(decodeLyrics(block.data?.lyric));
        translations=parseLyrics(decodeLyrics(block.data?.trans));
      }
    }
  }catch{}
  if(!lines.length){
    const url=new URL('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg');
    url.search=new URLSearchParams({songmid:mid,format:'json',nobase64:'1',trans:'1',g_tk:'5381',loginUin:'0',hostUin:'0',inCharset:'utf8',outCharset:'utf-8',platform:'yqq',needNewCode:'0'}).toString();
    const response=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error(`歌词请求失败：${response.status}`);
    const result=await response.json();
    if(result.code!==0)throw Error('当前歌曲的歌词暂不可用。');
    lines=parseLyrics(decodeLyrics(result.lyric));
    translations=parseLyrics(decodeLyrics(result.trans));
  }
  const data={songId:Number(id),lines:addTranslations(lines,translations)};
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
async function matchingPlaylistOrder(target,songs){
  const first=await browse('Q:0',0,200,target);
  if(first.total!==songs.length||!first.total)return null;
  const queueIds=items(first.xml).map(songIdFromItem);
  for(let start=200;start<first.total;start+=200){
    const page=await browse('Q:0',start,200,target);
    queueIds.push(...items(page.xml).map(songIdFromItem));
  }
  const order=matchPlaylistQueue(songs.map(song=>song.id),queueIds);
  return order?{order,updateId:first.updateId}:null;
}
async function confirmQueuePlayback(target,number,songId){
  const deadline=Date.now()+6500;
  let confirmed=0;
  while(Date.now()<deadline){
    const [transport,position]=await Promise.all([
      soap('AVTransport','GetTransportInfo',{InstanceID:0},target),
      soap('AVTransport','GetPositionInfo',{InstanceID:0},target)
    ]);
    const activeId=songIdFromUri(tag(position,'TrackURI'));
    confirmed=tag(transport,'CurrentTransportState')==='PLAYING'&&Number(tag(position,'Track'))===number&&activeId===songId?confirmed+1:0;
    if(confirmed>=2)return;
    await delay(300);
  }
  throw Error('Sonos 未确认播放所选歌曲，原队列已保留。');
}
async function qqQueueContext(target){
    const fav=items((await browse('FV:2',0,500)).xml).find(x=>tag(x,'title').includes('我喜欢')&&x.includes('PLAYLIST_FAV'));
    const favoriteUri=fav?tag(fav,'res'):'';
    const currentUri=tag(await soap('AVTransport','GetPositionInfo',{InstanceID:0},target),'TrackURI');
    const currentQQ=currentUri.startsWith('x-sonos-http:SONG')?currentUri:'';
    let queueUri='';
    if(!currentQQ){const queue=await browse('Q:0',0,200,target);queueUri=items(queue.xml).map(item=>tag(item,'res')).find(uri=>uri.startsWith('x-sonos-http:SONG')&&/[?&]sn=\d+/.test(uri))||'';}
    const source=currentQQ||queueUri||favoriteUri;
    const sid=/[?&]sid=(\d+)/.exec(source)?.[1]||/[?&]sid=(\d+)/.exec(favoriteUri)?.[1];
    const sn=/[?&]sn=(\d+)/.exec(source)?.[1]||/[?&]sn=(\d+)/.exec(favoriteUri)?.[1];
    if(!sid||!sn)throw Error('Sonos 中找不到 QQ 音乐播放账号。请先在 Sonos App 中播放一首 QQ 音乐歌曲，或将 QQ 歌单加入 Sonos 收藏。');
    return {sid,sn};
}
async function enqueueSong(target,song,asNext,context,position=0){
    const {sid,sn}=context||await qqQueueContext(target);
    const uri=`x-sonos-http:SONG%3a${song.id}%3aST.mp4?sid=${sid}&flags=8232&sn=${sn}`;
    const metadata=`<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="SONG:${song.id}:ST" parentID="" restricted="true"><dc:title>${enc(song.title)}</dc:title><dc:creator>${enc(song.artist)}</dc:creator><upnp:album>${enc(song.album)}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="sonos.com-http:*:audio/mp4:*">${enc(uri)}</res></item></DIDL-Lite>`;
    const number=tag(await soap('AVTransport','AddURIToQueue',{InstanceID:0,EnqueuedURI:uri,EnqueuedURIMetaData:metadata,DesiredFirstTrackNumberEnqueued:position,EnqueueAsNext:asNext?1:0},target),'FirstTrackNumberEnqueued');
    if(!number||number==='0')throw Error('已添加到队列，但 Sonos 未返回曲目位置。');
    return Number(number);
}
async function songByMid(mid){
  const found=searchedSongs.get(mid);
  if(found&&Date.now()-found.at<1800000)return found;
  const previous=recentPlays(historyAccount()).find(song=>song.mid===mid);
  if(previous)return previous;
  const list=await playlist(),song=list.songs.find(s=>s.mid===mid);
  if(!song)throw Error('歌曲不在当前歌单或近期搜索结果中，请重新搜索。');
  return song;
}
async function playSong(mid,roomId){
  const song=await songByMid(mid),{target}=await coordinator(roomId);
  let number=await queueTrack(target,song.id);
  if(!number){
    await enqueueSong(target,song,false);
    number=await queueTrack(target,song.id);
    if(!number)throw Error('歌曲已加入 Sonos 队列，但无法定位播放位置。请刷新队列后重试。');
  }
  await soap('AVTransport','Seek',{InstanceID:0,Unit:'TRACK_NR',Target:number},target);
  await soap('AVTransport','Play',{InstanceID:0,Speed:1},target);
  return {title:song.title,artist:song.artist,queueNumber:Number(number)};
}
const queueImports=new Map();
const shuffleModes=new Map();
const withQueueMutation=createKeyedMutationQueue();
const visibleQueueImport=job=>job&&!(job.phase==='complete'&&Date.now()-job.finishedAt>15000)?{phase:job.phase,title:job.title,selectedTitle:job.selectedTitle,added:job.added,total:job.total,error:job.error||''}:null;
function assertQueueIdle(target){
  if(['preparing','building'].includes(queueImports.get(target)?.phase))throw Error('歌单正在后台导入队列，请稍后再修改队列。');
}
async function enqueueDuringImport(target,song,context,position,expectedTotal){
  for(let attempt=0;attempt<3;attempt++){
    try{return await enqueueSong(target,song,false,context,position);}
    catch(error){
      const total=(await browse('Q:0',0,1,target)).total;
      if(total===expectedTotal+1)return;
      if(total!==expectedTotal||attempt===2)throw error;
    }
  }
}
function finishQueueImport(target,job,list,context,plan){
  void (async()=>{
    try{
      for(const {index,position} of plan){
        await withQueueMutation(target,async()=>{
          if(job.cancelled)return;
          await enqueueDuringImport(target,list.songs[index],context,position,job.added);
          if(position)job.order.unshift(index);else job.order.push(index);
          job.added++;
        });
        if(job.cancelled)return;
      }
      await withQueueMutation(target,async()=>{
        if(job.cancelled)return;
        const queueState=await browse('Q:0',0,1,target);
        if(queueState.total!==job.total)throw Error(`队列曲目数不一致：Sonos 返回 ${queueState.total} 首。`);
        job.phase='complete';job.finishedAt=Date.now();job.queueUpdateId=queueState.updateId;
      });
    }catch(error){
      if(!job.cancelled){job.phase='error';job.error=`已导入 ${job.added}/${job.total} 首；${error.message}`;console.error('歌单队列导入失败',error);}
    }finally{
      if(!job.cancelled&&job.originalMode&&job.originalMode!=='NORMAL')try{
        await withQueueMutation(target,async()=>{
          if(!job.cancelled)await soap('AVTransport','SetPlayMode',{InstanceID:0,NewPlayMode:job.originalMode},target);
        });
      }catch(error){job.phase='error';job.error=`${job.error||'队列已导入'}；恢复播放模式失败：${error.message}`;}
      if(!job.cancelled)job.modeRestored=true;
    }
  })();
}
async function startPlaylistPlayback(input,roomId){
  const list=await playlist();
  if(String(input.playlistId)!==list.id)throw Error('歌单已切换，请刷新后重新选择歌曲。');
  const index=Number(input.index)-1,song=list.songs[index];
  if(!song||song.mid!==String(input.mid||''))throw Error('歌曲与当前歌单不一致，请刷新后重试。');
  const {target,coordinatorId}=await coordinator(roomId);
  return withQueueMutation(target,async()=>{
    let previous=queueImports.get(target);
    if(!previous||['error','cancelled'].includes(previous.phase)){
      const match=await matchingPlaylistOrder(target,list.songs);
      if(match){
        previous={phase:'complete',playlistId:list.id,account:historyAccount(),title:list.title,selectedTitle:song.title,added:match.order.length,total:match.order.length,order:match.order,queueUpdateId:match.updateId,error:'',finishedAt:Date.now(),modeRestored:true};
        queueImports.set(target,previous);
      }
    }
    if(previous?.playlistId===list.id&&previous.account===historyAccount()&&['building','complete'].includes(previous.phase)){
      let position=previous.order.indexOf(index)+1;
      const expectedCount=previous.phase==='complete'?previous.total:previous.added;
      const queueState=await browse('Q:0',0,1,target);
      if(position&&queueState.total===expectedCount){
        if(previous.phase==='complete'&&requiresQueueRecheck(previous.queueUpdateId,queueState.updateId)){
          const match=await matchingPlaylistOrder(target,list.songs);
          if(match){previous.order=match.order;previous.queueUpdateId=match.updateId;position=match.order.indexOf(index)+1;}
          else position=0;
        }
        if(position){
          let item=items((await browse('Q:0',position-1,1,target)).xml)[0]||'';
          if(songIdFromItem(item)!==song.id&&previous.phase==='complete'){
            const match=await matchingPlaylistOrder(target,list.songs);
            if(match){previous.order=match.order;previous.queueUpdateId=match.updateId;position=match.order.indexOf(index)+1;item=items((await browse('Q:0',position-1,1,target)).xml)[0]||'';}
          }
          if(songIdFromItem(item)===song.id){
            await soap('AVTransport','Seek',{InstanceID:0,Unit:'TRACK_NR',Target:position},target);
            await soap('AVTransport','Play',{InstanceID:0,Speed:1},target);
            previous.selectedTitle=song.title;
            return {title:song.title,artist:song.artist,queueNumber:position,import:visibleQueueImport(previous)};
          }
        }
      }
    }
    const inheritMode=previous&&['preparing','building'].includes(previous.phase)||previous?.phase==='complete'&&!previous.modeRestored;
    if(previous&&['preparing','building','complete'].includes(previous.phase)){previous.cancelled=true;previous.phase='cancelled';}
    const job={phase:'preparing',playlistId:list.id,account:historyAccount(),title:list.title,selectedTitle:song.title,added:0,total:list.songs.length,order:[],error:''};
    queueImports.set(target,job);
    let modeBeforeImport='';
    const shuffleBeforeImport=shuffleModes.get(target);
    try{
      const context=await qqQueueContext(target);
      const mode=tag(await soap('AVTransport','GetTransportSettings',{InstanceID:0},target),'PlayMode');
      modeBeforeImport=mode;
      const customShuffle=shuffleModes.get(target)??mode.startsWith('SHUFFLE');
      shuffleModes.set(target,customShuffle);
      job.originalMode=customShuffle?withoutSonosShuffle(inheritMode&&previous.originalMode?previous.originalMode:mode):inheritMode&&previous.originalMode?previous.originalMode:mode;
      if(mode&&mode!=='NORMAL')await soap('AVTransport','SetPlayMode',{InstanceID:0,NewPlayMode:'NORMAL'},target);
      const oldCount=(await browse('Q:0',0,1,target)).total;
      await replaceQueueSafely({
        oldCount,
        append:()=>enqueueSong(target,song,false,context),
        play:async number=>{
          await soap('AVTransport','SetAVTransportURI',{InstanceID:0,CurrentURI:`x-rincon-queue:${coordinatorId}#0`,CurrentURIMetaData:''},target);
          await soap('AVTransport','Seek',{InstanceID:0,Unit:'TRACK_NR',Target:number},target);
          await soap('AVTransport','Play',{InstanceID:0,Speed:1},target);
          await confirmQueuePlayback(target,number,song.id);
        },
        removeStaged:async number=>{
          const page=await browse('Q:0',oldCount,1,target);
          if(page.total===oldCount)return;
          const item=items(page.xml)[0];
          if(page.total!==oldCount+1||!item||songIdFromItem(item)!==song.id||(number&&queueItemNumber(item)!==number))
            throw Error('队列在切换期间已变化，请刷新队列并检查末尾曲目。');
          const position=await soap('AVTransport','GetPositionInfo',{InstanceID:0},target);
          if(songIdFromUri(tag(position,'TrackURI'))===song.id)
            throw Error('音箱仍指向新歌曲，原队列已保留；请刷新队列检查播放状态。');
          await soap('AVTransport','RemoveTrackFromQueue',{InstanceID:0,ObjectID:`Q:0/${oldCount+1}`,UpdateID:0},target);
        },
        removeOld:async count=>{
          const page=await browse('Q:0',count,1,target);
          if(page.total!==count+1||songIdFromItem(items(page.xml)[0]||'')!==song.id)throw Error('队列在切换期间已变化，旧队列已保留。请刷新后重试。');
          await soap('AVTransport','RemoveTrackRangeFromQueue',{InstanceID:0,UpdateID:0,StartingIndex:1,NumberOfTracks:count},target);
        }
      });
      job.phase='building';job.added=1;job.order=[index];
      const plan=customShuffle
        ?shuffledIndices(remainingPlaylistIndices(list.songs.length,index,[index])).map(i=>({index:i,position:0}))
        :[...Array.from({length:list.songs.length-index-1},(_,offset)=>({index:index+offset+1,position:0})),
          ...Array.from({length:index},(_,offset)=>({index:index-offset-1,position:1}))];
      finishQueueImport(target,job,list,context,plan);
      return {title:song.title,artist:song.artist,queueNumber:1,import:visibleQueueImport(job)};
    }catch(error){
      job.phase='error';job.error=error.message;
      if(shuffleBeforeImport===undefined)shuffleModes.delete(target);else shuffleModes.set(target,shuffleBeforeImport);
      if(modeBeforeImport&&modeBeforeImport!=='NORMAL')try{await soap('AVTransport','SetPlayMode',{InstanceID:0,NewPlayMode:modeBeforeImport},target);}catch{}
      throw error;
    }
  });
}
async function rebuildManagedTail(target,enabled,restoreMode){
  if(!cached||cached.id!==selectedPlaylistId)return false;
  const list=cached;
  let job=queueImports.get(target);
  if(!job||job.playlistId!==list.id||job.account!==historyAccount()||!['building','complete'].includes(job.phase)){
    const match=await matchingPlaylistOrder(target,list.songs);
    if(!match)return false;
    job={phase:'complete',playlistId:list.id,account:historyAccount(),title:list.title,selectedTitle:'',added:match.order.length,total:match.order.length,order:match.order,queueUpdateId:match.updateId,modeRestored:true};
  }
  const queueState=await browse('Q:0',0,1,target);
  if(queueState.total!==job.added)return false;
  if(job.phase==='complete'&&requiresQueueRecheck(job.queueUpdateId,queueState.updateId)){
    const match=await matchingPlaylistOrder(target,list.songs);
    if(!match)return false;
    job.order=match.order;job.queueUpdateId=match.updateId;
  }
  const position=await soap('AVTransport','GetPositionInfo',{InstanceID:0},target);
  const current=Number(tag(position,'Track'));
  if(!Number.isInteger(current)||current<1||current>job.order.length)return false;
  let currentIndex=job.order[current-1];
  if(songIdFromUri(tag(position,'TrackURI'))!==list.songs[currentIndex]?.id&&job.phase==='complete'){
    const match=await matchingPlaylistOrder(target,list.songs);
    if(match){job.order=match.order;job.queueUpdateId=match.updateId;currentIndex=job.order[current-1];}
  }
  if(songIdFromUri(tag(position,'TrackURI'))!==list.songs[currentIndex]?.id)return false;
  const prefix=job.order.slice(0,current);
  const remaining=remainingPlaylistIndices(list.songs.length,currentIndex,prefix);
  const desired=enabled?shuffledIndices(remaining,undefined,job.order.slice(current)):remaining;
  if(!desired.length||job.phase==='complete'&&desired.length===job.order.length-current&&desired.every((index,offset)=>index===job.order[current+offset])){
    queueImports.set(target,job);return true;
  }
  const context=await qqQueueContext(target);
  const first=desired[0],oldCount=queueState.total;
  await replaceQueueTailSafely({
    appendFirst:()=>enqueueSong(target,list.songs[first],false,context),
    validateFirst:async stagedNumber=>{
      const staged=items((await browse('Q:0',oldCount,1,target)).xml)[0];
      if(stagedNumber!==oldCount+1||songIdFromItem(staged)!==list.songs[first].id)
        throw Error('队列在重新排序时已变化，请刷新队列。');
    },
    removeOldTail:async()=>{
      if(oldCount>current)try{
        await soap('AVTransport','RemoveTrackRangeFromQueue',
          {InstanceID:0,UpdateID:0,StartingIndex:current+1,NumberOfTracks:oldCount-current},target);
      }catch(error){
        const page=await browse('Q:0',current,1,target);
        if(page.total===current+1&&songIdFromItem(items(page.xml)[0]||'')===list.songs[first].id)return;
        throw error;
      }
    },
    rollbackFirst:async()=>{
      const page=await browse('Q:0',oldCount,1,target);
      if(page.total!==oldCount+1)throw Error('队列在随机排序时已变化，请刷新播放队列。');
      const staged=items(page.xml)[0];
      if(songIdFromItem(staged)===list.songs[first].id)
        await soap('AVTransport','RemoveTrackFromQueue',{InstanceID:0,ObjectID:`Q:0/${oldCount+1}`,UpdateID:0},target);
    }
  });
  job.cancelled=true;job.phase='cancelled';
  const replacement={phase:'building',playlistId:list.id,account:historyAccount(),title:list.title,
    selectedTitle:list.songs[currentIndex].title,added:current+1,total:list.songs.length,order:[...prefix,first],error:'',originalMode:withoutSonosShuffle(job.originalMode||restoreMode)};
  queueImports.set(target,replacement);
  finishQueueImport(target,replacement,list,context,desired.slice(1).map(index=>({index,position:0})));
  return true;
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
  for(const song of searchedSongs.values())if(!songLookup.has(song.id))songLookup.set(song.id,song);
  if(!songLookup.size){try{songLookup=new Map((await playlist()).songs.map(song=>[song.id,song]));}catch{}}
  const tracks=items(page.xml).map(item=>{
    const number=queueItemNumber(item);
    const songId=songIdFromItem(item);
    const song=songLookup.get(songId);
    return {number,songId,key:queueItemKey(item),title:tag(item,'title')||song?.title||'未知歌曲',artist:tag(item,'creator')||song?.artist||'',album:tag(item,'album')||song?.album||'',albumMid:song?.albumMid||''};
  }).filter(track=>track.number);
  return {tracks,total:page.total,start};
}
async function playQueueTrack(input,roomId){
  const number=Number(input.number);
  if(!Number.isInteger(number)||number<1||number>10000)throw Error('队列位置无效。');
  if(!/^[a-f0-9]{24}$/.test(String(input.key||'')))throw Error('请刷新播放队列后重试。');
  const {target}=await coordinator(roomId);
  const page=await browse('Q:0',number-1,1,target);
  const item=items(page.xml)[0];
  assertQueueTrack(item?{number:queueItemNumber(item),key:queueItemKey(item)}:null,{number,key:input.key});
  await soap('AVTransport','Seek',{InstanceID:0,Unit:'TRACK_NR',Target:number},target);
  await soap('AVTransport','Play',{InstanceID:0,Speed:1},target);
}
async function editQueue(input,roomId){
  const number=Number(input.number),{target}=await coordinator(roomId);
  if(!Number.isInteger(number)||number<1||number>10000)throw Error('队列位置无效。');
  if(!/^[a-f0-9]{24}$/.test(String(input.key||'')))throw Error('请刷新播放队列后重试。');
  const page=await browse('Q:0',number-1,1,target),item=items(page.xml)[0];
  assertQueueTrack(item?{number:queueItemNumber(item),key:queueItemKey(item)}:null,{number,key:input.key});
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
async function roomList(refresh=false){
  const state=await topology(refresh);
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
    let song=cached?.songs.find(s=>s.id===songId)||searchedSongById(songId);
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
  return {room,roomId:selectedRoomId,groupSize,model,ip:new URL(device).hostname,playing:tag(transport,'CurrentTransportState')==='PLAYING',state:tag(transport,'CurrentTransportState'),volume:Number(tag(volume,'CurrentVolume')),groupVolume:groupSize>1?Number(tag(groupVolume,'CurrentVolume')):null,mute:tag(mute,'CurrentMute')==='1',shuffle:shuffleModes.get(target)===true||mode.startsWith('SHUFFLE'),repeatOne:['REPEAT_ONE','SHUFFLE_REPEAT_ONE'].includes(mode),repeatAll:['REPEAT_ALL','SHUFFLE'].includes(mode),crossfade:tag(crossfade,'CrossfadeMode')==='1',playMode:mode,title,artist,album,albumArt,songId,track:Number(tag(position,'Track')),position:tag(position,'RelTime'),duration};
}
async function control(action,value,roomId,selected){
  const {target,device,groupSize}=selected||await coordinator(roomId), transport=(name,args={})=>soap('AVTransport',name,{InstanceID:0,...args},target);
  if(action==='play')await transport('Play',{Speed:1}); else if(action==='pause')await transport('Pause');
  else if(action==='next'||action==='previous'){
    await transport(action==='next'?'Next':'Previous');
    await transport('Play',{Speed:1});
  }
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
  else if(action==='shuffle'){
    if(typeof value!=='boolean')throw Error('随机播放值无效。');
    const mode=tag(await transport('GetTransportSettings'),'PlayMode');
    const normalMode=withoutSonosShuffle(mode);
    if(mode!==normalMode)await transport('SetPlayMode',{NewPlayMode:normalMode});
    let managed=false;
    try{managed=await rebuildManagedTail(target,value,normalMode);}catch(error){
      if(mode!==normalMode)try{await transport('SetPlayMode',{NewPlayMode:mode});}catch{}
      throw error;
    }
    if(!managed){
      const repeat=normalMode==='REPEAT_ALL'?'all':normalMode==='REPEAT_ONE'?'one':'none';
      const sonosMode=value?{none:'SHUFFLE_NOREPEAT',all:'SHUFFLE',one:'SHUFFLE_REPEAT_ONE'}[repeat]:normalMode;
      if(sonosMode!==normalMode)await transport('SetPlayMode',{NewPlayMode:sonosMode});
    }
    shuffleModes.set(target,value);
  }
  else if(action==='repeatOne'||action==='repeatAll'){
    if(typeof value!=='boolean')throw Error('播放模式值无效。');
    const mode=tag(await transport('GetTransportSettings'),'PlayMode');
    const shuffled=mode.startsWith('SHUFFLE');
    const repeat=['REPEAT_ALL','SHUFFLE'].includes(mode)?'all':['REPEAT_ONE','SHUFFLE_REPEAT_ONE'].includes(mode)?'one':'none';
    const nextShuffle=shuffled;
    const nextRepeat=action==='repeatOne'?(value?'one':'none'):action==='repeatAll'?(value?'all':'none'):repeat;
    const modes=nextShuffle?{none:'SHUFFLE_NOREPEAT',all:'SHUFFLE',one:'SHUFFLE_REPEAT_ONE'}:{none:'NORMAL',all:'REPEAT_ALL',one:'REPEAT_ONE'};
    await transport('SetPlayMode',{NewPlayMode:modes[nextRepeat]});
    const job=queueImports.get(target);
    if(job&&!job.modeRestored&&['building','complete'].includes(job.phase))job.originalMode=modes[nextRepeat];
  }else throw Error('未知控制命令。');
}
const send=(res,code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function requestBody(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)throw Error('请求太大。');}return JSON.parse(raw||'{}');}
const isLocal=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const localWrite=req=>isLocal(req)&&(!req.headers.origin||[`http://localhost:${port}`,`http://127.0.0.1:${port}`].includes(req.headers.origin));
const isLan=req=>isLocal(req)||(()=>{const address=(req.socket.remoteAddress||'').replace(/^::ffff:/,'');if(/^10\.|^192\.168\./.test(address))return true;const match=address.match(/^172\.(\d+)\./);return !!match&&Number(match[1])>=16&&Number(match[1])<=31;})();
const qrWrite=req=>{if(!isLan(req))return false;const host=req.headers.host;if(!host)return false;const origin=req.headers.origin||req.headers.referer;if(!origin)return isLocal(req);try{return new URL(origin).host===host&&new URL(origin).protocol==='http:';}catch{return false;}};
http.createServer(async(req,res)=>{try{
  const requestUrl=new URL(req.url,`http://${req.headers.host||'localhost'}`),pathname=requestUrl.pathname,roomId=requestUrl.searchParams.get('room')||undefined;
  if(req.method==='GET'&&pathname==='/api/status')return send(res,200,await status(roomId));
  if(req.method==='GET'&&pathname==='/api/rooms')return send(res,200,await roomList(requestUrl.searchParams.has('refresh')));
  if(req.method==='POST'&&pathname==='/api/rooms/group'){await setGroup(await requestBody(req));return send(res,200,await roomList());}
  if(req.method==='GET'&&pathname==='/api/queue'){
    const start=Number(requestUrl.searchParams.get('start')||0);
    if(!Number.isInteger(start)||start<0||start>10000)return send(res,400,{error:'队列位置无效。'});
    return send(res,200,await queuePage(start,roomId));
  }
  if(req.method==='GET'&&pathname==='/api/queue/import'){
    const {target}=await coordinator(roomId);return send(res,200,{import:visibleQueueImport(queueImports.get(target))});
  }
  if(req.method==='POST'&&pathname==='/api/queue/play'){
    const body=await requestBody(req),{target}=await coordinator(roomId);
    await withQueueMutation(target,async()=>{assertQueueIdle(target);await playQueueTrack(body,roomId);});return send(res,200,{ok:true});
  }
  if(req.method==='POST'&&pathname==='/api/queue/edit'){
    const body=await requestBody(req),{target}=await coordinator(roomId);
    await withQueueMutation(target,async()=>{assertQueueIdle(target);await editQueue(body,roomId);});return send(res,200,{ok:true});
  }
  if(req.method==='POST'&&pathname==='/api/queue/add'){
    const body=await requestBody(req),{target}=await coordinator(roomId);
    const result=await withQueueMutation(target,async()=>{assertQueueIdle(target);return addSongToQueue(String(body.mid||''),body.placement,roomId);});
    return send(res,200,{ok:true,...result});
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
  if(req.method==='GET'&&pathname==='/api/qq/session')return send(res,200,{...sessionState(),selectedId:selectedPlaylistId,local:isLocal(req),canQrLogin:isLan(req)});
  if(req.method==='POST'&&pathname==='/api/qq/session/select'){
    const body=await requestBody(req);await selectSession(String(body.id||''));cached=null;playlistCatalog=null;selectedPlaylistId=selectedPlaylist();return send(res,200,sessionState());
  }
  if(pathname==='/api/qq/login/cookie'&&!localWrite(req))return send(res,403,{error:'请通过运行服务的设备上的 localhost 导入 Cookie。'});
  if(['/api/qq/login/qr','/api/qq/login/poll'].includes(pathname)&&!qrWrite(req))return send(res,403,{error:'请从同一局域网的网页打开 QQ 音乐扫码登录。'});
  if(req.method==='POST'&&pathname==='/api/qq/login/qr')return send(res,200,await beginQr());
  if(req.method==='GET'&&pathname==='/api/qq/login/poll'){const result=await pollQr();if(result.state==='connected'){cached=null;playlistCatalog=null;selectedPlaylistId=selectedPlaylist();}return send(res,200,result);}
  if(req.method==='POST'&&pathname==='/api/qq/login/cookie'){const b=await requestBody(req);await saveSession(b.cookie);cached=null;playlistCatalog=null;selectedPlaylistId=selectedPlaylist();return send(res,200,{ok:true});}
  if(req.method==='GET'&&pathname==='/api/playlists')return send(res,200,{playlists:await playlists(requestUrl.searchParams.has('refresh')),selectedId:selectedPlaylistId});
  if(req.method==='GET'&&pathname==='/api/history')return send(res,200,{songs:recentPlays(historyAccount()).map((song,index)=>({...song,index:index+1}))});
  if(req.method==='POST'&&pathname==='/api/history/record'){
    const body=await requestBody(req),song=await songByMid(String(body.mid||'')),current=await status(roomId);
    if(!current.playing||current.songId!==song.id)return send(res,409,{error:'音箱尚未确认播放这首歌。'});
    await recordPlay(historyAccount(),song);return send(res,200,{ok:true});
  }
  if(req.method==='DELETE'&&pathname==='/api/history'){await clearPlayHistory(historyAccount());return send(res,200,{ok:true});}
  if(req.method==='GET'&&pathname==='/api/search')return send(res,200,await searchSongs(requestUrl.searchParams.get('q'),requestUrl.searchParams.get('page')));
  if(req.method==='POST'&&pathname==='/api/playlists/select'){
    const body=await requestBody(req),id=String(body.id||'');
    if(!(await playlists()).some(item=>item.id===id))return send(res,400,{error:'歌单不属于当前 QQ 音乐账号。'});
    await saveSelectedPlaylist(id);selectedPlaylistId=id;cached=null;return send(res,200,{selectedId:id});
  }
  if(req.method==='GET'&&pathname==='/api/playlist'){const p=await playlist(new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.has('refresh'));return send(res,200,{account:p.account,id:p.id,title:p.title,songs:p.songs,updatedAt:new Date(p.at).toISOString()});}
  if(req.method==='POST'&&pathname==='/api/control'){
    const b=await requestBody(req);
    if(['play','pause','next','previous','seek','shuffle','repeatOne','repeatAll'].includes(b.action)){
      const selected=await coordinator(roomId);
      await withQueueMutation(selected.target,()=>control(b.action,b.value,roomId,selected));
    }else await control(b.action,b.value,roomId);
    return send(res,200,{ok:true});
  }
  if(req.method==='POST'&&pathname==='/api/play'){
    const b=await requestBody(req),{target}=await coordinator(roomId);
    const result=await withQueueMutation(target,async()=>{assertQueueIdle(target);return playSong(String(b.mid||''),roomId);});
    return send(res,200,{ok:true,...result});
  }
  if(req.method==='POST'&&pathname==='/api/play/playlist'){const b=await requestBody(req);return send(res,200,{ok:true,...await startPlaylistPlayback(b,roomId)});}
  const file=pathname==='/'?'index.html':pathname.slice(1);if(req.method!=='GET'||!['index.html','app.js','transport-sync.mjs','library-navigation.mjs','playlist-cache.mjs','style.css','favicon.svg'].includes(file))return send(res,404,{error:'页面不存在。'});
  const contents=await readFile(path.join(dir,file));res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml'}[path.extname(file)]});res.end(contents);
}catch(e){console.error(e);send(res,500,{error:e.message||'服务出错。'});}}).listen(port,host,()=>console.log(`Sonos web http://${host}:${port}; Sonos ${process.env.SONOS_IP||'自动发现'}`));
