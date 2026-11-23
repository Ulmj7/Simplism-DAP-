export interface Rect {left:number;top:number;width:number;height:number}
export interface Size {width:number;height:number}
export interface Placement {top:number;left:number;placement:"below"|"above"|"beside"|"top"|"bottom";maxHeight?:number;scrollBy?:number}
const HALO=4,MIN_CARD=96; // the highlight ring extends 4px around the target; a card is never squeezed below 96px
/** Phones: the card is docked to the top or bottom edge. It must leave the highlighted control visible, so it is capped to the room left
 *  next to the control and, when the control sits where the card would be, `scrollBy` says how far to scroll the page (px) to bring it into the free band. */
function dockCard(target:Rect,cardHeight:number,viewport:Size,margin:number,gap:number):Placement {
 const height=Math.min(cardHeight,Math.max(MIN_CARD,viewport.height-2*margin-gap-target.height-2*HALO));
 const dock=(placement:"top"|"bottom"):Placement=>{
  const top=placement==="top"?margin:Math.max(margin,viewport.height-height-margin);
  const lo=placement==="top"?top+height+gap:0,hi=placement==="top"?viewport.height:top-gap;
  const ringTop=target.top-(placement==="top"?HALO:0),ringBottom=target.top+target.height+(placement==="top"?0:HALO);
  let shift=0;if(ringBottom>hi)shift=hi-ringBottom;if(ringTop+shift<lo)shift=lo-ringTop;
  return {left:margin,top,placement,maxHeight:height,scrollBy:shift===0?0:-shift};
 };
 const preferred:"top"|"bottom"=target.top+target.height/2>viewport.height/2?"top":"bottom";
 const first=dock(preferred),other=dock(preferred==="top"?"bottom":"top");
 return Math.abs(other.scrollBy??0)<Math.abs(first.scrollBy??0)?other:first;
}
export function placeCard({target,card,viewport}:{target:Rect;card:Size;viewport:Size}):Placement {
 const margin=8,gap=12;const width=Math.min(card.width,Math.max(0,viewport.width-2*margin));const height=Math.min(card.height,Math.max(0,viewport.height-2*margin));
 const clamp=(n:number,max:number)=>Math.max(margin,Math.min(n,max-margin));
 if(viewport.width<768)return dockCard(target,height,viewport,margin,gap);
 let left=target.left,top=target.top+target.height+gap;let placement:"below"|"above"|"beside"="below";
 if(top+height>viewport.height-margin){if(target.top-gap-height>=margin){top=target.top-gap-height;placement="above";}else if(target.left+target.width+gap+width<=viewport.width-margin){left=target.left+target.width+gap;top=target.top;placement="beside";}else if(target.left-gap-width>=margin){left=target.left-gap-width;top=target.top;placement="beside";}}
 return {left:clamp(left,viewport.width-width),top:clamp(top,viewport.height-height),placement};
}
