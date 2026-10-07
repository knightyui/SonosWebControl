import dgram from 'node:dgram';
import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';

const search=Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n');
const missing=()=>Error('未发现 Sonos 音箱。请确认音箱与服务在同一局域网，或在“房间与分组”中重新发现。');

export function parseSonosResponse(message,sender){
  const text=message.toString();
  if(!/^HTTP\/1\.[01] 200\b/i.test(text))return null;
  const headers=Object.fromEntries(text.split(/\r?\n/).slice(1).filter(line=>line.includes(':')).map(line=>{
    const colon=line.indexOf(':');return [line.slice(0,colon).trim().toLowerCase(),line.slice(colon+1).trim()];
  }));
  if(!/ZonePlayer|Sonos|RINCON_/i.test(`${headers.st} ${headers.server} ${headers.usn}`))return null;
  try{
    const url=new URL(headers.location);
    if(url.protocol!=='http:'||url.port!=='1400'||isIP(url.hostname)!==4||url.hostname!==sender||url.username||url.password||url.pathname!=='/xml/device_description.xml'||url.search||url.hash)return null;
    return url.origin;
  }catch{return null;}
}

export async function discoverSonos({addresses,createSocket=()=>dgram.createSocket('udp4'),timeoutMs=1800}={}){
  addresses??=[...new Set(Object.values(networkInterfaces()).flat().filter(item=>item&&!item.internal&&(item.family==='IPv4'||item.family===4)).map(item=>item.address))];
  const results=await Promise.all(addresses.map(address=>new Promise(resolve=>{
    const found=new Set();let socket;
    try{socket=createSocket();}catch{resolve([]);return;}
    let done=false,repeat;
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(repeat);try{socket.close();}catch{}resolve([...found]);};
    const timer=setTimeout(finish,timeoutMs);
    socket.on('error',finish);
    socket.on('message',(message,remote)=>{const origin=parseSonosResponse(message,remote.address);if(origin)found.add(origin);});
    try{socket.bind(0,address,()=>{
      if(done)return;
      try{
        socket.setMulticastInterface(address);socket.setMulticastTTL(2);
        const send=()=>{if(!done)socket.send(search,1900,'239.255.255.250',error=>{if(error)finish();});};
        send();repeat=setTimeout(send,300);
      }catch{finish();}
    });}catch{finish();}
  })));
  return [...new Set(results.flat())].sort();
}

const xmlTag=(xml,name)=>new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i').exec(xml)?.[1]||'';
export async function inspectSonos(origin){
  const response=await fetch(`${origin}/xml/device_description.xml`,{signal:AbortSignal.timeout(1800),redirect:'error'});
  if(!response.ok)throw Error('Sonos 设备信息不可用。');
  const description=await response.text(),id=xmlTag(description,'UDN').replace(/^uuid:/i,'');
  if(!/Sonos/i.test(xmlTag(description,'manufacturer'))||!/^RINCON_[\w]+$/.test(id))throw Error('设备不是 Sonos 音箱。');
  return {origin,id,description};
}

export function createSonosLocator({seedIp='',discover=discoverSonos,inspect=inspectSonos,now=Date.now}={}){
  seedIp=seedIp.trim();
  if(seedIp&&isIP(seedIp)!==4)throw Error('SONOS_IP 应为音箱的 IPv4 地址；留空可自动发现。');
  const seed=seedIp?`http://${seedIp}:1400`:null;
  let primary=null,preferredId='',pending=null,lastFailure=-Infinity;
  return {
    async resolve(force=false){
      if(pending)return pending;
      if(primary&&!force)return primary;
      if(!force&&now()-lastFailure<5000)throw missing();
      pending=(async()=>{
        if(seed&&!force){try{primary=await inspect(seed);preferredId=primary.id;return primary;}catch{}}
        const origins=new Set(await discover());if(seed)origins.add(seed);
        const results=await Promise.allSettled([...origins].map(origin=>inspect(origin)));
        const devices=results.filter(result=>result.status==='fulfilled').map(result=>result.value).sort((a,b)=>a.id.localeCompare(b.id));
        primary=devices.find(device=>device.id===preferredId)||devices[0]||null;
        if(!primary)throw missing();
        preferredId=primary.id;return primary;
      })().catch(error=>{lastFailure=now();throw error;}).finally(()=>{pending=null;});
      return pending;
    },
    invalidate(origin){if(primary?.origin===origin){preferredId=primary.id;primary=null;}}
  };
}
