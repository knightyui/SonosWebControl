const key='sonos-playlist-cache-v1';
const valid=entry=>entry&&typeof entry.account==='string'&&entry.account&&entry.data&&typeof entry.data.id==='string'&&typeof entry.data.title==='string'&&Array.isArray(entry.data.songs)&&entry.data.songs.length<=10000&&entry.data.songs.every(song=>Number.isInteger(song.id)&&typeof song.mid==='string'&&typeof song.title==='string'&&Number.isInteger(song.index));

// Browser storage is optional: private browsing and quota failures must not block playback.
export function createPlaylistCache(storage){
  function entries(){
    try{const saved=JSON.parse(storage.getItem(key));return saved?.version===1&&Array.isArray(saved.entries)?saved.entries.filter(valid):[];}catch{return [];}
  }
  return {
    latest:()=>entries()[0]||null,
    read:(account,id)=>entries().find(entry=>entry.account===account&&entry.data.id===id)||null,
    write(account,data){
      const entry={account,data};if(!valid(entry))return;
      const saved=[entry,...entries().filter(item=>item.account!==account||item.data.id!==data.id)].slice(0,3);
      try{
        while(saved.length){
          const json=JSON.stringify({version:1,entries:saved});
          if(json.length<=2_000_000){try{storage.setItem(key,json);return;}catch{}}
          saved.pop();
        }
      }catch{/* Cache is best effort. */}
    },
    clear(){try{storage.removeItem(key);}catch{}}
  };
}

// Short-lived query results stay in memory and are isolated from account changes.
export function createQueryCache({now=Date.now,ttl=300000,limit=40}={}){
  const entries=new Map(),pending=new Map();let epoch=0;
  const key=(account,query,page)=>JSON.stringify([account,String(query).trim().toLocaleLowerCase(),page]);
  const copy=value=>structuredClone(value);
  return {
    async load(account,query,page,loader){
      const id=key(account,query,page),hit=entries.get(id);
      if(hit&&now()-hit.at<ttl){entries.delete(id);entries.set(id,hit);return copy(hit.data);}
      if(pending.has(id))return copy(await pending.get(id));
      const generation=epoch;
      const task=Promise.resolve().then(loader).then(data=>{
        if(generation===epoch){entries.delete(id);entries.set(id,{at:now(),data:copy(data)});while(entries.size>limit)entries.delete(entries.keys().next().value);}
        return data;
      });
      pending.set(id,task);
      try{return copy(await task);}finally{if(pending.get(id)===task)pending.delete(id);}
    },
    clear(){epoch++;entries.clear();pending.clear();}
  };
}

export function createLibraryViewStore(storage){
  const key='sonos-library-views-v1';
  const valid=e=>e&&typeof e.account==='string'&&e.account&&typeof e.id==='string'&&e.id&&
    typeof e.query==='string'&&e.query.length<=160&&Number.isInteger(e.visible)&&e.visible>=60&&e.visible<=10000&&
    Number.isFinite(e.top)&&e.top>=0&&e.top<=2000000;
  function read(){try{const value=JSON.parse(storage.getItem(key));return value?.version===1&&Array.isArray(value.entries)?value.entries.filter(valid).slice(0,12):[];}catch{return [];}}
  return {
    read:(account,id)=>read().find(e=>e.account===account&&e.id===id)||null,
    write(account,id,view){const entry={account,id,...view};if(!valid(entry))return;try{storage.setItem(key,JSON.stringify({version:1,entries:[entry,...read().filter(e=>e.account!==account||e.id!==id)].slice(0,12)}));}catch{}},
    clear(){try{storage.removeItem(key);}catch{}}
  };
}
