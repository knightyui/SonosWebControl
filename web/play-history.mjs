import {readFile, writeFile, rename, chmod} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const file=path.join(path.dirname(fileURLToPath(import.meta.url)),'.play-history.json');
let history={};
let writing=Promise.resolve();

export async function loadPlayHistory(){
  try{
    const saved=JSON.parse(await readFile(file,'utf8'));
    if(saved&&typeof saved==='object'&&!Array.isArray(saved))history=saved;
  }catch(error){if(error.code!=='ENOENT')console.warn('本地播放记录未加载：',error.message);}
}

function persist(){
  writing=writing.catch(()=>{}).then(async()=>{
    const temporary=`${file}.tmp`;
    await writeFile(temporary,JSON.stringify(history),{encoding:'utf8',mode:0o600});
    await chmod(temporary,0o600);
    await rename(temporary,file);
  });
  return writing;
}

export function recentPlays(account){return (history[account||'local']||[]).slice(0,100);}

export async function recordPlay(account,song){
  if(!song?.mid||!song?.id)return;
  const key=account||'local';
  const entry={id:song.id,mid:song.mid,title:song.title,artist:song.artist,album:song.album,albumMid:song.albumMid,duration:song.duration,playedAt:new Date().toISOString()};
  history[key]=[entry,...recentPlays(key).filter(item=>item.mid!==song.mid)].slice(0,100);
  await persist();
}

export async function clearPlayHistory(account){history[account||'local']=[];await persist();}
