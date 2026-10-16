// Focus and the software keyboard can move a sheet before the click arrives.
// Only dismiss gestures that started and finished on its backdrop.
export function bindBackdropDismiss(dialog){
  let backdropBounds=null;
  const outside=(event,bounds)=>{
    return event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom;
  };
  const reset=()=>{backdropBounds=null;};
  dialog.addEventListener('pointerdown',event=>{
    const bounds=dialog.getBoundingClientRect();
    backdropBounds=event.button===0&&event.target===dialog&&outside(event,bounds)?bounds:null;
  });
  dialog.addEventListener('pointercancel',reset);
  dialog.addEventListener('close',reset);
  dialog.addEventListener('click',event=>{
    const dismiss=backdropBounds&&event.detail>0&&outside(event,backdropBounds);
    reset();
    if(dismiss)dialog.close();
  });
}
