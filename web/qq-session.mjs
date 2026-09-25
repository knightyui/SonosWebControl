import {readFile, writeFile, chmod} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const file=path.join(path.dirname(fileURLToPath(import.meta.url)),'.qq-session.json');
let cookie='';
let active='';
const accounts=new Map();
const selectedPlaylists=new Map();
let pending=null;
const pairs=headers=>headers.getSetCookie().map(value=>value.split(';',1)[0]).filter(Boolean);
const merge=(jar,values)=>{for(const value of values){const i=value.indexOf('=');if(i>0&&value.slice(i+1))jar.set(value.slice(0,i),value.slice(i+1));}};
const joined=jar=>[...jar].map(([key,value])=>`${key}=${value}`).join('; ');
const hash=value=>{let result=0;for(const c of value)result=(result+(result<<5)+c.charCodeAt(0))&0x7fffffff;return result;};
const gtk=value=>{let result=5381;for(const c of value)result+=(result<<5)+c.charCodeAt(0);return result&0x7fffffff;};
const timeout=()=>AbortSignal.timeout(15000);
function checkCookie(value){
  if(typeof value!=='string'||value.length>16000||/[\r\n]/.test(value))throw Error('Cookie 格式无效。');
  const jar=new Map(value.split(';').map(part=>part.trim()).filter(Boolean).map(part=>{const i=part.indexOf('=');return [part.slice(0,i),part.slice(i+1)];}));
  if(!(/^[o]?\d+$/.test(jar.get('uin')||'')||/^\d+$/.test(jar.get('wxuin')||'')))throw Error('Cookie 中缺少 QQ 音乐账号标识 uin。');
  if(!['qm_keyst','qqmusic_key','qqmusic_key2'].some(key=>jar.get(key)))throw Error('Cookie 中缺少 QQ 音乐登录票据。');
  return joined(jar);
}
const accountId=value=>{
  const uin=/(?:^|;)\s*uin=o?(\d+)/.exec(value)?.[1]||'';
  const wxuin=/(?:^|;)\s*wxuin=(\d+)/.exec(value)?.[1]||'';
  return uin&&uin!=='0'?uin:wxuin||uin;
};
async function persist(){await writeFile(file,JSON.stringify({active,accounts:Object.fromEntries(accounts),selectedPlaylists:Object.fromEntries(selectedPlaylists)}),{encoding:'utf8',mode:0o600});await chmod(file,0o600);}
export async function loadSession(){try{
  const saved=JSON.parse(await readFile(file,'utf8'));
  if(saved.cookie){const valid=checkCookie(saved.cookie);accounts.set(accountId(valid),valid);active=accountId(valid);}
  for(const [id,value] of Object.entries(saved.accounts||{})){try{const valid=checkCookie(value);if(accountId(valid)===id)accounts.set(id,valid);}catch{}}
  if(accounts.has(saved.active))active=saved.active;
  if(!accounts.has(active))active=accounts.keys().next().value||'';
  cookie=accounts.get(active)||'';
  for(const [id,playlistId] of Object.entries(saved.selectedPlaylists||{}))if(accounts.has(id)&&/^(liked|\d{1,20})$/.test(String(playlistId)))selectedPlaylists.set(id,String(playlistId));
}catch(e){if(e.code!=='ENOENT')console.warn('QQ 会话未加载：',e.message);}}
export const sessionCookie=()=>cookie;
export const selectedPlaylist=()=>selectedPlaylists.get(active)||'liked';
export async function saveSelectedPlaylist(id){if(!active)throw Error('请先登录 QQ 音乐。');selectedPlaylists.set(active,id);await persist();}
export const sessionState=()=>({connected:Boolean(cookie),method:cookie?'QQ 音乐会话':'未登录',active,accounts:[...accounts.keys()].map(id=>({id}))});
export async function saveSession(value){const valid=checkCookie(value),id=accountId(valid);accounts.set(id,valid);active=id;cookie=valid;await persist();}
export async function selectSession(id){if(!accounts.has(id))throw Error('QQ 音乐账号不存在。');active=id;cookie=accounts.get(id);await persist();}
export async function beginQr(){
  const url=new URL('https://ssl.ptlogin2.qq.com/ptqrshow');
  url.search=new URLSearchParams({appid:'716027609',e:'2',l:'M',s:'3',d:'72',v:'4',daid:'383',pt_3rd_aid:'100497308',u1:'https://graph.qq.com/oauth2.0/login_jump'}).toString();
  const response=await fetch(url,{signal:timeout()});
  if(!response.ok)throw Error(`QQ 登录二维码请求失败：${response.status}`);
  const sig=pairs(response.headers).find(item=>item.startsWith('qrsig='))?.slice(6);
  if(!sig)throw Error('QQ 登录服务没有返回二维码会话。');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>200000)throw Error('QQ 登录二维码过大。');
  pending={sig,token:hash(sig),expires:Date.now()+180000};
  return {image:`data:image/png;base64,${bytes.toString('base64')}`};
}
export async function pollQr(){
  if(!pending||Date.now()>pending.expires)throw Error('二维码已过期，请重新获取。');
  const p=pending;
  const url=new URL('https://ssl.ptlogin2.qq.com/ptqrlogin');
  url.search=new URLSearchParams({u1:'https://graph.qq.com/oauth2.0/login_jump',ptqrtoken:String(p.token),ptredirect:'0',h:'1',t:'1',g:'1',from_ui:'1',ptlang:'2052',action:`0-0-${Date.now()}`,js_ver:'23111510',js_type:'1',pt_uistyle:'40',aid:'716027609',daid:'383',pt_3rd_aid:'100497308'}).toString();
  const response=await fetch(url,{headers:{Cookie:`qrsig=${p.sig}`,Referer:'https://xui.ptlogin2.qq.com/'},signal:timeout()});
  const body=await response.text();
  if(body.includes('二维码已失效')||body.includes('二维码已过期')){pending=null;return {state:'expired'};}
  if(!body.includes('登录成功'))return {state:body.includes('认证中')?'scanned':'waiting'};
  const checkUrl=body.match(/https?:\/\/[^'\s]+/)?.[0];
  const callback=checkUrl&&new URL(checkUrl);
  if(!callback||callback.protocol!=='https:'||!/(^|\.)qq\.com$/.test(callback.hostname))throw Error(`QQ 登录回调地址无效：${callback?.hostname||'未知域名'}。`);
  const jar=new Map([['qrsig',p.sig]]);
  let next=callback,verified;
  for(let i=0;i<6;i++){
    verified=await fetch(next,{redirect:'manual',headers:{Cookie:joined(jar)},signal:timeout()});
    merge(jar,pairs(verified.headers));
    const location=verified.headers.get('location');
    if(!location||jar.get('p_skey'))break;
    next=new URL(location,next);
    if(next.protocol!=='https:'||!/(^|\.)qq\.com$/.test(next.hostname))throw Error('QQ 登录跳转地址无效。');
  }
  const secret=jar.get('p_skey');
  if(!secret){console.warn('QQ check_sig without p_skey',{status:verified.status,host:next.hostname,path:next.pathname,cookies:[...jar].map(([name,value])=>`${name}:${value.length}`)});throw Error('QQ 登录没有返回授权票据。请重新获取二维码，或导入浏览器 Cookie。');}
  const form=new FormData();
  for(const [key,value] of Object.entries({response_type:'code',client_id:'100497308',redirect_uri:'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',scope:'get_user_info,get_app_friends',state:'state',switch:'',from_ptlogin:'1',src:'1',update_auth:'1',openapi:'1010_1030',g_tk:String(gtk(secret)),auth_time:new Date().toString(),ui:randomUUID()}))form.append(key,value);
  const auth=await fetch('https://graph.qq.com/oauth2.0/authorize',{method:'POST',body:form,redirect:'manual',headers:{Cookie:joined(jar)},signal:timeout()});
  merge(jar,pairs(auth.headers));
  const code=new URL(auth.headers.get('location')||'https://y.qq.com/').searchParams.get('code');
  if(!code)throw Error('QQ 授权没有返回登录代码。');
  const login=await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg',{method:'POST',headers:{'Content-Type':'application/json',Cookie:joined(jar),Referer:'https://y.qq.com/'},body:JSON.stringify({comm:{g_tk:gtk(secret),platform:'yqq',ct:24,cv:0},req:{module:'QQConnectLogin.LoginServer',method:'QQLogin',param:{code}}}),signal:timeout()});
  if(!login.ok)throw Error(`QQ 音乐登录失败：${login.status}`);
  const result=await login.json();if(result.req?.code!==0)throw Error(`QQ 音乐登录失败：${result.req?.code??'未知错误'}`);
  merge(jar,pairs(login.headers));
  await saveSession(joined(jar));
  pending=null;
  return {state:'connected'};
}
