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
