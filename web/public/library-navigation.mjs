export function currentPlaylistIndex(songs,songId){
  if(!Number.isInteger(Number(songId))||Number(songId)<=0)return -1;
  return songs.findIndex(song=>Number(song.id)===Number(songId));
}

export function visibleCountForIndex(index,total,batch=60){
  if(index<0||index>=total)return 0;
  return Math.min(total,Math.ceil((index+1)/batch)*batch);
}
