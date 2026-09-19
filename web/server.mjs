import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beginQr,loadSession,pollQr,saveSession,sessionCookie,sessionState} from './qq-session.mjs';

const ip=process.env.SONOS_IP;
if(!ip)throw Error('请设置 SONOS_IP，例如 SONOS_IP=192.168.x.x npm start。');
const host=process.env.HOST||'0.0.0.0', port=Number(process.env.PORT||38473);
const base=`http://${ip}:1400`, dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const routes={AVTransport:'/MediaRenderer/AVTransport/Control',RenderingControl:'/MediaRenderer/RenderingControl/Control',ContentDirectory:'/MediaServer/ContentDirectory/Control',ZoneGroupTopology:'/ZoneGroupTopology/Control'};
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
async function coordinator(){
  const description=await (await fetch(base+'/xml/device_description.xml',{signal:AbortSignal.timeout(5000)})).text();
  const udn=tag(description,'UDN'), state=tag(await soap('ZoneGroupTopology','GetZoneGroupState'),'ZoneGroupState');
  const group=[...state.matchAll(/<ZoneGroup\b[^>]*>[\s\S]*?<\/ZoneGroup>/g)].find(m=>m[0].includes(udn))?.[0];
  const id=group&&attr(group,'Coordinator');
  const member=id&&[...group.matchAll(/<ZoneGroupMember\b[^>]*>/g)].find(m=>attr(m[0],'UUID')===id)?.[0];
  return {target:member?new URL(attr(member,'Location')).origin:base,room:tag(description,'roomName')||'Sonos',model:tag(description,'modelName')||'Sonos'};
}
async function browse(id,start=0,count=200,target=base){
  const x=await soap('ContentDirectory','Browse',{ObjectID:id,BrowseFlag:'BrowseDirectChildren',Filter:'*',StartingIndex:start,RequestedCount:count,SortCriteria:''},target);
  return {xml:tag(x,'Result'),total:Number(tag(x,'TotalMatches'))};
}
const items=x=>[...x.matchAll(/<item\b[^>]*>[\s\S]*?<\/item>/g)].map(m=>m[0]);
let cached;
const lyricsCache=new Map();
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
  const songs=data.cdlist[0].songlist.map((s,i)=>({index:i+1,id:Number(s.songid||s.id),mid:String(s.songmid||s.mid||''),title:s.songname||s.name||'',artist:(s.singer||[]).map(a=>a.name).join('、'),album:s.albumname||'',duration:Number(s.interval||0)})).filter(s=>s.id&&s.mid);
  cached={id,title:'我喜欢',songs,at:Date.now()}; return cached;
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
async function playSong(mid){
  const list=await playlist(), song=list.songs.find(s=>s.mid===mid); if(!song)throw Error('歌曲不在当前歌单中，请刷新歌单。');
  const {target}=await coordinator(); let number=await queueTrack(target,song.id);
  if(!number){
    const fav=items((await browse('FV:2',0,500)).xml).find(x=>tag(x,'title').includes('我喜欢')&&x.includes('PLAYLIST_FAV'));
    const res=fav&&tag(fav,'res'), sid=/[?&]sid=(\d+)/.exec(res)?.[1]||'23';
    const queueSample=(await browse('Q:0',0,1,target)).xml;
    const sn=/x-sonos-http:[^<]*[?&]sn=(\d+)/.exec(queueSample)?.[1]||'6';
    const uri=`x-sonos-http:SONG%3a${song.id}%3aST.mp4?sid=${sid}&flags=8232&sn=${sn}`;
    const metadata=`<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="SONG:${song.id}:ST" parentID="" restricted="true"><dc:title>${enc(song.title)}</dc:title><dc:creator>${enc(song.artist)}</dc:creator><upnp:album>${enc(song.album)}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="sonos.com-http:*:audio/mp4:*">${enc(uri)}</res></item></DIDL-Lite>`;
    number=tag(await soap('AVTransport','AddURIToQueue',{InstanceID:0,EnqueuedURI:uri,EnqueuedURIMetaData:metadata,DesiredFirstTrackNumberEnqueued:0,EnqueueAsNext:0},target),'FirstTrackNumberEnqueued');
    if(!number||number==='0')throw Error('已添加到队列，但 Sonos 未返回曲目位置。');
  }
  await soap('AVTransport','Seek',{InstanceID:0,Unit:'TRACK_NR',Target:number},target);
  await soap('AVTransport','Play',{InstanceID:0,Speed:1},target);
  return {title:song.title,artist:song.artist,queueNumber:Number(number)};
}
async function status(){
  const {target,room,model}=await coordinator();
  const [transport,position,settings,volume,mute]=await Promise.all([
    soap('AVTransport','GetTransportInfo',{InstanceID:0},target),soap('AVTransport','GetPositionInfo',{InstanceID:0},target),
    soap('AVTransport','GetTransportSettings',{InstanceID:0},target),soap('RenderingControl','GetVolume',{InstanceID:0,Channel:'Master'}),soap('RenderingControl','GetMute',{InstanceID:0,Channel:'Master'})]);
  const metadata=tag(position,'TrackMetaData'), mode=tag(settings,'PlayMode');
  const art=tag(metadata,'albumArtURI');
  let albumArt=null;
  if(art){try{const url=new URL(art,target);if(url.origin===target)albumArt=`/api/art?uri=${encodeURIComponent(url.pathname+url.search)}`;}catch{}}
  const uri=tag(position,'TrackURI'),songId=Number(/SONG(?:%3[aA]|:)(\d+)(?:(?:%3[aA]|:)|\.)/.exec(uri)?.[1]||0);
  return {room,model,ip,playing:tag(transport,'CurrentTransportState')==='PLAYING',state:tag(transport,'CurrentTransportState'),volume:Number(tag(volume,'CurrentVolume')),mute:tag(mute,'CurrentMute')==='1',shuffle:mode.startsWith('SHUFFLE'),playMode:mode,title:tag(metadata,'title'),artist:tag(metadata,'creator'),album:tag(metadata,'album'),albumArt,songId,track:Number(tag(position,'Track')),position:tag(position,'RelTime'),duration:tag(position,'TrackDuration')};
}
async function control(action,value){
  const {target}=await coordinator(), transport=(name,args={})=>soap('AVTransport',name,{InstanceID:0,...args},target);
  if(action==='play')await transport('Play',{Speed:1}); else if(action==='pause')await transport('Pause');
  else if(action==='next')await transport('Next'); else if(action==='previous')await transport('Previous');
  else if(action==='volume'){const n=Number(value);if(!Number.isInteger(n)||n<0||n>100)throw Error('音量必须在 0–100 之间。');await soap('RenderingControl','SetVolume',{InstanceID:0,Channel:'Master',DesiredVolume:n});}
  else if(action==='mute')await soap('RenderingControl','SetMute',{InstanceID:0,Channel:'Master',DesiredMute:value?1:0});
  else if(action==='seek'){
    const seconds=Number(value);
    if(!Number.isInteger(seconds)||seconds<0||seconds>86400)throw Error('播放位置无效。');
    const targetTime=`${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    await transport('Seek',{Unit:'REL_TIME',Target:targetTime});
  }
  else if(action==='shuffle'){
    const mode=tag(await transport('GetTransportSettings'),'PlayMode');
    const repeat=['REPEAT_ALL','SHUFFLE'].includes(mode)?'all':['REPEAT_ONE','SHUFFLE_REPEAT_ONE'].includes(mode)?'one':'none';
    await transport('SetPlayMode',{NewPlayMode:value?({none:'SHUFFLE_NOREPEAT',all:'SHUFFLE',one:'SHUFFLE_REPEAT_ONE'})[repeat]:({none:'NORMAL',all:'REPEAT_ALL',one:'REPEAT_ONE'})[repeat]});
  }else throw Error('未知控制命令。');
}
const send=(res,code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function requestBody(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)throw Error('请求太大。');}return JSON.parse(raw||'{}');}
const isLocal=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const localWrite=req=>isLocal(req)&&(!req.headers.origin||[`http://localhost:${port}`,`http://127.0.0.1:${port}`].includes(req.headers.origin));
http.createServer(async(req,res)=>{try{
  const pathname=new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname;
  if(req.method==='GET'&&pathname==='/api/status')return send(res,200,await status());
  if(req.method==='GET'&&pathname==='/api/lyrics'){
    const id=new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.get('id')||'';
    if(!/^\d{1,12}$/.test(id))return send(res,400,{error:'歌曲 ID 无效。'});
    return send(res,200,await lyricsForSong(id));
  }
  if(req.method==='GET'&&pathname==='/api/art'){
    const {target}=await coordinator(),uri=new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.get('uri')||'';
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
  if(req.method==='GET'&&pathname==='/api/qq/session')return send(res,200,{...sessionState(),local:isLocal(req)});
  if(pathname.startsWith('/api/qq/login/')&&!localWrite(req))return send(res,403,{error:'请在 Mac 本机打开 localhost 登录 QQ 音乐。'});
  if(req.method==='POST'&&pathname==='/api/qq/login/qr')return send(res,200,await beginQr());
  if(req.method==='GET'&&pathname==='/api/qq/login/poll')return send(res,200,await pollQr());
  if(req.method==='POST'&&pathname==='/api/qq/login/cookie'){const b=await requestBody(req);await saveSession(b.cookie);cached=null;return send(res,200,{ok:true});}
  if(req.method==='GET'&&pathname==='/api/playlist'){const p=await playlist(new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.has('refresh'));return send(res,200,{id:p.id,title:p.title,songs:p.songs,updatedAt:new Date(p.at).toISOString()});}
  if(req.method==='POST'&&pathname==='/api/control'){const b=await requestBody(req);await control(b.action,b.value);return send(res,200,{ok:true});}
  if(req.method==='POST'&&pathname==='/api/play'){const b=await requestBody(req);return send(res,200,{ok:true,...await playSong(String(b.mid||''))});}
  const file=pathname==='/'?'index.html':pathname.slice(1);if(req.method!=='GET'||!['index.html','app.js','style.css'].includes(file))return send(res,404,{error:'页面不存在。'});
  const contents=await readFile(path.join(dir,file));res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}[path.extname(file)]});res.end(contents);
}catch(e){console.error(e);send(res,500,{error:e.message||'服务出错。'});}}).listen(port,host,()=>console.log(`Sonos web http://${host}:${port}; Sonos ${ip}`));
