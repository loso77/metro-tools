import {detectTargetGrid,fallbackQuad,quadPoint} from './locator-core.mjs';

const $=id=>document.getElementById(id);
const E={
  imageInput:$('imageInput'),workspace:$('workspace'),rowCard:$('rowCard'),status:$('status'),confidence:$('confidence'),
  autoBtn:$('autoBtn'),defaultBtn:$('defaultBtn'),resetBtn:$('resetBtn'),stage:$('stage'),photoCanvas:$('photoCanvas'),
  cropCanvas:$('cropCanvas'),cropDivider:$('cropDivider'),rowTitle:$('rowTitle'),rowHint:$('rowHint'),
  previousRow:$('previousRow'),nextRow:$('nextRow'),carStart:$('carStart'),trackStart:$('trackStart'),
  carStartValue:$('carStartValue'),trackStartValue:$('trackStartValue'),topUp:$('topUp'),topDown:$('topDown'),
  bottomUp:$('bottomUp'),bottomDown:$('bottomDown')
};

const state={
  image:null,sourcePixels:null,width:0,height:0,quad:null,lastAutoQuad:null,rowStops:null,lastAutoRowStops:null,lastAutoColumns:null,selectedRow:0,
  carStart:.30,trackStart:.64,dragCorner:-1,dragMoved:false,pointerStart:null,fileName:''
};
const ctx=E.photoCanvas.getContext('2d',{willReadFrequently:true});
const cropCtx=E.cropCanvas.getContext('2d');

function cloneQuad(quad){return quad.map(p=>({...p}))}
function equalRowStops(){return Array.from({length:32},(_,index)=>index/31)}
function rowStop(index){return state.rowStops?.[index]??index/31}
function setStatus(message){E.status.textContent=message}
function confidenceLabel(value,debug={}){
  E.confidence.className='confidence';
  if(value>=.78){E.confidence.textContent=`定位较稳 ${Math.round(value*100)}%`;E.confidence.classList.add('good')}
  else if(value>=.5){E.confidence.textContent=`建议核对 ${Math.round(value*100)}%`;E.confidence.classList.add('medium')}
  else{E.confidence.textContent='请手动调整';E.confidence.classList.add('low')}
  if(debug.rowMatches)E.confidence.title=`检测到 ${debug.rowMatches}/32 条行边界`;
}

function drawPolygon(context,points,fill,stroke,lineWidth=2){
  context.beginPath();context.moveTo(points[0].x,points[0].y);
  for(let i=1;i<points.length;i++)context.lineTo(points[i].x,points[i].y);
  context.closePath();
  if(fill){context.fillStyle=fill;context.fill()}
  if(stroke){context.strokeStyle=stroke;context.lineWidth=lineWidth;context.stroke()}
}

function rowCell(row,u0,u1){
  const v0=rowStop(row),v1=rowStop(row+1);
  return [quadPoint(state.quad,u0,v0),quadPoint(state.quad,u1,v0),quadPoint(state.quad,u1,v1),quadPoint(state.quad,u0,v1)];
}

function draw(){
  if(!state.image||!state.quad)return;
  ctx.clearRect(0,0,state.width,state.height);
  ctx.drawImage(state.image,0,0,state.width,state.height);

  const scale=state.width/Math.max(1,E.photoCanvas.getBoundingClientRect().width);
  drawPolygon(ctx,state.quad,'rgba(15,118,110,.035)','rgba(15,118,110,.95)',Math.max(2,2.2*scale));

  const selectedCar=rowCell(state.selectedRow,state.carStart,state.trackStart);
  const selectedTrack=rowCell(state.selectedRow,state.trackStart,1);
  drawPolygon(ctx,selectedCar,'rgba(15,118,110,.28)','rgba(15,118,110,.98)',Math.max(2,2*scale));
  drawPolygon(ctx,selectedTrack,'rgba(234,123,44,.28)','rgba(234,123,44,.98)',Math.max(2,2*scale));

  ctx.lineWidth=Math.max(1,1.1*scale);
  for(let row=0;row<=31;row++){
    const a=quadPoint(state.quad,0,rowStop(row)),b=quadPoint(state.quad,1,rowStop(row));
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
    ctx.strokeStyle=row===state.selectedRow||row===state.selectedRow+1?'rgba(239,68,68,.95)':'rgba(15,118,110,.48)';ctx.stroke();
  }
  for(const [u,color,width] of [[state.carStart,'rgba(15,118,110,.95)',2],[state.trackStart,'rgba(234,123,44,.98)',2]]){
    const a=quadPoint(state.quad,u,0),b=quadPoint(state.quad,u,1);
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=color;ctx.lineWidth=Math.max(2,width*scale);ctx.stroke();
  }

  const tableLabel=String(31+state.selectedRow);
  const labelAt=quadPoint(state.quad,.08,(rowStop(state.selectedRow)+rowStop(state.selectedRow+1))/2);
  ctx.save();ctx.font=`800 ${Math.max(12,14*scale)}px -apple-system, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.lineWidth=Math.max(2,3*scale);ctx.strokeStyle='rgba(255,255,255,.92)';ctx.strokeText(tableLabel,labelAt.x,labelAt.y);
  ctx.fillStyle='#b91c1c';ctx.fillText(tableLabel,labelAt.x,labelAt.y);ctx.restore();

  state.quad.forEach(point=>{
    const radius=Math.max(5,7*scale);
    ctx.beginPath();ctx.arc(point.x,point.y,radius,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=Math.max(2,2.2*scale);ctx.strokeStyle='#ef4444';ctx.stroke();
  });
  renderRowCrop();
}

function samplePixel(data,width,height,x,y){
  x=Math.max(0,Math.min(width-1,Math.round(x)));y=Math.max(0,Math.min(height-1,Math.round(y)));
  const i=(y*width+x)*4;return [data[i],data[i+1],data[i+2],data[i+3]];
}

function renderRowCrop(){
  if(!state.sourcePixels||!state.quad)return;
  const outputWidth=760,outputHeight=120,row=state.selectedRow;
  E.cropCanvas.width=outputWidth;E.cropCanvas.height=outputHeight;
  const output=cropCtx.createImageData(outputWidth,outputHeight),source=state.sourcePixels.data;
  for(let y=0;y<outputHeight;y++){
    const rowRatio=(y+.5)/outputHeight,v=rowStop(row)+(rowStop(row+1)-rowStop(row))*rowRatio;
    for(let x=0;x<outputWidth;x++){
      const u=state.carStart+(1-state.carStart)*(x+.5)/outputWidth;
      const point=quadPoint(state.quad,u,v),pixel=samplePixel(source,state.width,state.height,point.x,point.y),i=(y*outputWidth+x)*4;
      output.data[i]=pixel[0];output.data[i+1]=pixel[1];output.data[i+2]=pixel[2];output.data[i+3]=255;
    }
  }
  cropCtx.putImageData(output,0,0);
  E.cropDivider.style.left=`${((state.trackStart-state.carStart)/(1-state.carStart))*100}%`;
  E.rowTitle.textContent=`表号 ${31+row}`;
  E.rowHint.textContent=`当前查看第 ${row+1}/31 行。拖动上方红色四角后，放大图会同步更新。`;
  E.rowCard.classList.remove('hidden');
}

function canvasPoint(event){
  const rect=E.photoCanvas.getBoundingClientRect();
  return {x:(event.clientX-rect.left)*state.width/rect.width,y:(event.clientY-rect.top)*state.height/rect.height};
}

function pointInPolygon(point,polygon){
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];
    if(((a.y>point.y)!==(b.y>point.y))&&(point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x))inside=!inside;
  }
  return inside;
}

function rowAtPoint(point){
  for(let row=0;row<31;row++)if(pointInPolygon(point,rowCell(row,0,1)))return row;
  return -1;
}

E.photoCanvas.addEventListener('pointerdown',event=>{
  if(!state.quad)return;
  const point=canvasPoint(event),rect=E.photoCanvas.getBoundingClientRect(),threshold=34*state.width/rect.width;
  let nearest=-1,distance=Infinity;
  state.quad.forEach((corner,index)=>{const d=Math.hypot(corner.x-point.x,corner.y-point.y);if(d<distance){distance=d;nearest=index}});
  state.dragCorner=distance<=threshold?nearest:-1;state.dragMoved=false;state.pointerStart=point;
  E.photoCanvas.setPointerCapture(event.pointerId);
});
E.photoCanvas.addEventListener('pointermove',event=>{
  if(state.dragCorner<0)return;
  const point=canvasPoint(event);if(Math.hypot(point.x-state.pointerStart.x,point.y-state.pointerStart.y)>3)state.dragMoved=true;
  state.quad[state.dragCorner]={x:Math.max(0,Math.min(state.width,point.x)),y:Math.max(0,Math.min(state.height,point.y))};draw();
});
E.photoCanvas.addEventListener('pointerup',event=>{
  const point=canvasPoint(event);
  if(state.dragCorner<0&&!state.dragMoved){const row=rowAtPoint(point);if(row>=0){state.selectedRow=row;draw()}}
  state.dragCorner=-1;state.pointerStart=null;
  try{E.photoCanvas.releasePointerCapture(event.pointerId)}catch{}
});
E.photoCanvas.addEventListener('pointercancel',()=>{state.dragCorner=-1;state.pointerStart=null});

async function autoLocate(){
  if(!state.image)return;
  E.autoBtn.disabled=true;setStatus('正在分析表格线和31行结构……');
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  try{
    const detectWidth=Math.min(720,state.width),detectHeight=Math.max(1,Math.round(state.height*detectWidth/state.width));
    const detector=document.createElement('canvas');detector.width=detectWidth;detector.height=detectHeight;
    const detectorCtx=detector.getContext('2d',{willReadFrequently:true});detectorCtx.drawImage(state.image,0,0,detectWidth,detectHeight);
    const result=detectTargetGrid(detectorCtx.getImageData(0,0,detectWidth,detectHeight));
    const sx=state.width/detectWidth,sy=state.height/detectHeight;
    state.quad=result.points.map(p=>({x:p.x*sx,y:p.y*sy}));state.lastAutoQuad=cloneQuad(state.quad);
    state.rowStops=result.rowStops?.length===32?[...result.rowStops]:equalRowStops();state.lastAutoRowStops=[...state.rowStops];
    if(result.columns){
      state.carStart=result.columns.carStart;state.trackStart=result.columns.trackStart;
      state.lastAutoColumns={carStart:state.carStart,trackStart:state.trackStart};
      E.carStart.value=Math.round(state.carStart*100);E.trackStart.value=Math.round(state.trackStart*100);
      E.carStartValue.textContent=`${Math.round(state.carStart*100)}%`;E.trackStartValue.textContent=`${Math.round(state.trackStart*100)}%`;
    }
    confidenceLabel(result.confidence,result.debug);
    if(result.confidence>=.78)setStatus('自动定位完成。请点击几行抽查，确认框线落在正确单元格。');
    else setStatus(`自动定位仅作初始参考：${result.debug.reason||'请拖动四角修正'}。`);
    draw();
  }catch(error){
    state.quad=fallbackQuad(state.width,state.height);state.rowStops=equalRowStops();state.lastAutoQuad=cloneQuad(state.quad);state.lastAutoRowStops=[...state.rowStops];confidenceLabel(0);
    setStatus('自动定位失败，已显示默认框；请拖动四角修正。'+(error?.message||''));draw();
  }finally{E.autoBtn.disabled=false}
}

async function loadFile(file){
  if(!file||!/^image\/(jpeg|png|webp)$/.test(file.type))return;
  const url=URL.createObjectURL(file),image=new Image();image.decoding='async';image.src=url;
  try{await image.decode()}catch{URL.revokeObjectURL(url);setStatus('照片读取失败。');return}
  const scale=Math.min(1,1800/Math.max(image.naturalWidth,image.naturalHeight));
  state.width=Math.max(1,Math.round(image.naturalWidth*scale));state.height=Math.max(1,Math.round(image.naturalHeight*scale));
  state.image=image;state.fileName=file.name;state.selectedRow=0;
  E.photoCanvas.width=state.width;E.photoCanvas.height=state.height;
  ctx.drawImage(image,0,0,state.width,state.height);state.sourcePixels=ctx.getImageData(0,0,state.width,state.height);
  E.workspace.classList.remove('hidden');E.rowCard.classList.remove('hidden');
  setStatus('照片只在本机浏览器中处理，不会上传。');
  await autoLocate();
  URL.revokeObjectURL(url);
}

E.imageInput.addEventListener('change',()=>loadFile(E.imageInput.files?.[0]));
E.autoBtn.addEventListener('click',autoLocate);
E.defaultBtn.addEventListener('click',()=>{if(!state.image)return;state.quad=fallbackQuad(state.width,state.height);state.rowStops=equalRowStops();confidenceLabel(0);setStatus('已使用默认框，请拖动四角到31行顶部和61行底部。');draw()});
E.resetBtn.addEventListener('click',()=>{if(!state.lastAutoQuad)return;state.quad=cloneQuad(state.lastAutoQuad);state.rowStops=state.lastAutoRowStops?[...state.lastAutoRowStops]:equalRowStops();if(state.lastAutoColumns){state.carStart=state.lastAutoColumns.carStart;state.trackStart=state.lastAutoColumns.trackStart;E.carStart.value=Math.round(state.carStart*100);E.trackStart.value=Math.round(state.trackStart*100);E.carStartValue.textContent=`${Math.round(state.carStart*100)}%`;E.trackStartValue.textContent=`${Math.round(state.trackStart*100)}%`;}setStatus('已恢复最近一次自动定位结果。');draw()});
E.previousRow.addEventListener('click',()=>{state.selectedRow=Math.max(0,state.selectedRow-1);draw()});
E.nextRow.addEventListener('click',()=>{state.selectedRow=Math.min(30,state.selectedRow+1);draw()});

function updateColumns(){
  state.carStart=Number(E.carStart.value)/100;state.trackStart=Number(E.trackStart.value)/100;
  if(state.trackStart<=state.carStart+.08){state.trackStart=state.carStart+.08;E.trackStart.value=Math.round(state.trackStart*100)}
  E.carStartValue.textContent=`${Math.round(state.carStart*100)}%`;E.trackStartValue.textContent=`${Math.round(state.trackStart*100)}%`;draw();
}
E.carStart.addEventListener('input',updateColumns);E.trackStart.addEventListener('input',updateColumns);

function nudgeEdge(edge,direction){
  if(!state.quad)return;
  const [leftTop,rightTop,rightBottom,leftBottom]=state.quad.map(point=>({...point}));
  if(edge==='top'){
    state.quad[0].x+=(leftBottom.x-leftTop.x)/31*direction;state.quad[0].y+=(leftBottom.y-leftTop.y)/31*direction;
    state.quad[1].x+=(rightBottom.x-rightTop.x)/31*direction;state.quad[1].y+=(rightBottom.y-rightTop.y)/31*direction;
  }else{
    state.quad[3].x+=(leftBottom.x-leftTop.x)/31*direction;state.quad[3].y+=(leftBottom.y-leftTop.y)/31*direction;
    state.quad[2].x+=(rightBottom.x-rightTop.x)/31*direction;state.quad[2].y+=(rightBottom.y-rightTop.y)/31*direction;
  }
  setStatus(`${edge==='top'?'31上边':'61下边'}已${direction>0?'下移':'上移'}一行。`);draw();
}
E.topUp.addEventListener('click',()=>nudgeEdge('top',-1));
E.topDown.addEventListener('click',()=>nudgeEdge('top',1));
E.bottomUp.addEventListener('click',()=>nudgeEdge('bottom',-1));
E.bottomDown.addEventListener('click',()=>nudgeEdge('bottom',1));
