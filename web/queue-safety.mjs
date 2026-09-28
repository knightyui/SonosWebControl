export function matchPlaylistQueue(playlistIds,queueIds){
  if(!playlistIds.length||playlistIds.length!==queueIds.length)return null;
  const positions=new Map();
  playlistIds.forEach((id,index)=>{
    if(!positions.has(id))positions.set(id,[]);
    positions.get(id).push(index);
  });
  const used=new Map(),order=[];
  for(const id of queueIds){
    const available=positions.get(id);
    const offset=used.get(id)||0;
    if(!available||offset>=available.length)return null;
    order.push(available[offset]);
    used.set(id,offset+1);
  }
  return order;
}

export function assertQueueTrack(actual,expected){
  if(!actual||actual.number!==expected.number||actual.key!==expected.key)
    throw Error('播放队列已变化，请刷新后重试。');
}

export function requiresQueueRecheck(previousUpdateId,currentUpdateId){
  return !previousUpdateId||!currentUpdateId||previousUpdateId!==currentUpdateId;
}

export async function replaceQueueSafely({oldCount,append,play,removeOld,removeStaged}){
  let stagedNumber;
  try{
    stagedNumber=await append();
    await play(stagedNumber);
  }catch(error){
    try{await removeStaged(stagedNumber);}catch(cleanupError){
      throw Error(`${error.message}；新曲目清理失败：${cleanupError.message}`,{cause:error});
    }
    throw error;
  }
  if(oldCount)await removeOld(oldCount);
  return stagedNumber;
}
