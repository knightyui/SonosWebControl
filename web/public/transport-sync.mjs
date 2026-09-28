export function seconds(value){
  const parts=String(value||'0:00').split(':').map(Number);
  if(parts.some(part=>!Number.isFinite(part)))return 0;
  return parts.length===3?parts[0]*3600+parts[1]*60+parts[2]:parts.length===2?parts[0]*60+parts[1]:0;
}

export function assessTransport(status,expected,now=Date.now()){
  const elapsed=Math.max(0,(now-expected.startedAt)/1000);
  const position=expected.position==null?null:Math.min(seconds(status.duration)||Infinity,expected.position+(expected.playing?elapsed:0));
  const positionMatches=position==null||Math.abs(seconds(status.position)-position)<=3;
  const trackChanged=!expected.requireTrackChange||status.track!==expected.previousTrack||
    Boolean(status.songId&&expected.previousSongId&&status.songId!==expected.previousSongId)||
    seconds(status.position)<Math.max(0,expected.previousPosition-3);
  return {confirmed:status.playing===expected.playing&&positionMatches&&trackChanged,
    displayPosition:position==null?null:Math.floor(position)};
}

export function createOperationTracker(){
  let latest=0;
  return {begin:()=>++latest,isCurrent:operation=>operation===latest};
}
