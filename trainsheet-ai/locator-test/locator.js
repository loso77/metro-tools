import {detectTargetGrid,fallbackQuad,quadPoint} from './locator-core.mjs?v=20260717-6';

const $=id=>document.getElementById(id);
const E={
  imageInput:$('imageInput'),workspace:$('workspace'),rowCard:$('rowCard'),status:$('status'),confidence:$('confidence'),
  autoBtn:$('autoBtn'),defaultBtn:$('defaultBtn'),resetBtn:$('resetBtn'),stage:$('stage'),photoCanvas:$('photoCanvas'),
  cropCanvas:$('cropCanvas'),cropDivider:$('cropDivider'),rowTitle:$('rowTitle'),rowHint:$('rowHint'),
  previousRow:$('previousRow'),nextRow:$('nextRow'),carStart:$('carStart'),trackStart:$('trackStart'),
  carStartValue:$('carStartValue'),trackStartValue:$('trackStartValue'),topUp:$('topUp'),topDown:$('topDown'),
  bottomUp:$('bottomUp'),bottomDown:$('bottomDown'),batchCard:$('batchCard'),batchRows:$('batchRows'),
  batchStatus:$('batchStatus'),regenerateRows:$('regenerateRows'),copyRows:$('copyRows'),clearRows:$('clearRows')
};

const state={
  image:null,sourcePixels:null,width:0,height:0,quad:null,lastAutoQuad:null,rowStops:null,lastAutoRowStops:null,rowEdges:null,lastAutoRowEdges:null,lastAutoColumns:null,selectedRow:0,
  carStart:.30,trackStart:.64,dragCorner:-1,dragMoved:false,pointerStart:null,fileName:'',
  entries:Array.from({length:31},()=>({train:'',track:''}))
};
const ctx=E.photoCanvas.getContext('2d',{willReadFrequently:true});
const cropCtx=E.cropCanvas.getContext('2d');
let batchRenderTimer=0;

function cloneQuad(quad){return quad.map(p=>({...p}))}
function cloneRowEdges(rowEdges){return rowEdges?.map(edge=>({left:{...edge.left},right:{...edge.right}}))??null}
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
  if(state.rowEdges?.length===32){
    const top=state.rowEdges[row],bottom=state.rowEdges[row+1];
    const point=(edge,u)=>({x:edge.left.x+(edge.right.x-edge.left.x)*u,y:edge.left.y+(edge.right.y-edge.left.y)*u});
    return [point(top,u0),point(top,u1),point(bottom,u1),point(bottom,u0)];
  }
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
    const a=state.rowEdges?.[row]?.left??quadPoint(state.quad,0,rowStop(row)),b=state.rowEdges?.[row]?.right??quadPoint(state.quad,1,rowStop(row));
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
    ctx.strokeStyle=row===state.selectedRow||row===state.selectedRow+1?'rgba(239,68,68,.95)':'rgba(15,118,110,.48)';ctx.stroke();
  }
  for(const [u,color,width] of [[state.carStart,'rgba(15,118,110,.95)',2],[state.trackStart,'rgba(234,123,44,.98)',2]]){
    ctx.beginPath();
    if(state.rowEdges?.length===32){
      state.rowEdges.forEach((edge,index)=>{const point={x:edge.left.x+(edge.right.x-edge.left.x)*u,y:edge.left.y+(edge.right.y-edge.left.y)*u};if(index)ctx.lineTo(point.x,point.y);else ctx.moveTo(point.x,point.y)});
    }else{const a=quadPoint(state.quad,u,0),b=quadPoint(state.quad,u,1);ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y)}
    ctx.strokeStyle=color;ctx.lineWidth=Math.max(2,width*scale);ctx.stroke();
  }

  const tableLabel=String(31+state.selectedRow);
  const labelCell=rowCell(state.selectedRow,.03,.13),labelAt={x:(labelCell[0].x+labelCell[1].x+labelCell[2].x+labelCell[3].x)/4,y:(labelCell[0].y+labelCell[1].y+labelCell[2].y+labelCell[3].y)/4};
  ctx.save();ctx.font=`800 ${Math.max(12,14*scale)}px -apple-system, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.lineWidth=Math.max(2,3*scale);ctx.strokeStyle='rgba(255,255,255,.92)';ctx.strokeText(tableLabel,labelAt.x,labelAt.y);
  ctx.fillStyle='#b91c1c';ctx.fillText(tableLabel,labelAt.x,labelAt.y);ctx.restore();

  state.quad.forEach(point=>{
    const radius=Math.max(5,7*scale);
    ctx.beginPath();ctx.arc(point.x,point.y,radius,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=Math.max(2,2.2*scale);ctx.strokeStyle='#ef4444';ctx.stroke();
  });
  renderRowCrop();
}

function paintRowCrop(canvas,context,row,outputWidth,outputHeight,drawDivider=false){
  if(!state.sourcePixels||!state.quad)return;
  canvas.width=outputWidth;canvas.height=outputHeight;
  const output=context.createImageData(outputWidth,outputHeight),source=state.sourcePixels.data,sourceWidth=state.width,sourceHeight=state.height;
  const localQuad=state.rowEdges?.length===32?rowCell(row,0,1):null;
  for(let y=0;y<outputHeight;y++){
    const rowRatio=(y+.5)/outputHeight,v=rowStop(row)+(rowStop(row+1)-rowStop(row))*rowRatio;
    for(let x=0;x<outputWidth;x++){
      const u=state.carStart+(1-state.carStart)*(x+.5)/outputWidth,point=localQuad?quadPoint(localQuad,u,rowRatio):quadPoint(state.quad,u,v);
      const sourceX=Math.max(0,Math.min(sourceWidth-1,Math.round(point.x))),sourceY=Math.max(0,Math.min(sourceHeight-1,Math.round(point.y)));
      const sourceIndex=(sourceY*sourceWidth+sourceX)*4,outputIndex=(y*outputWidth+x)*4;
      output.data[outputIndex]=source[sourceIndex];output.data[outputIndex+1]=source[sourceIndex+1];output.data[outputIndex+2]=source[sourceIndex+2];output.data[outputIndex+3]=255;
    }
  }
  context.putImageData(output,0,0);
  if(drawDivider){
    const divider=(state.trackStart-state.carStart)/(1-state.carStart)*outputWidth;
    context.beginPath();context.moveTo(divider,0);context.lineTo(divider,outputHeight);context.strokeStyle='#ea7b2c';context.lineWidth=3;context.stroke();
  }
}

function renderRowCrop(){
  if(!state.sourcePixels||!state.quad)return;
  const row=state.selectedRow;
  paintRowCrop(E.cropCanvas,cropCtx,row,760,120);
  E.cropDivider.style.left=`${((state.trackStart-state.carStart)/(1-state.carStart))*100}%`;
  E.rowTitle.textContent=`表号 ${31+row}`;
  E.rowHint.textContent=`当前查看第 ${row+1}/31 行。拖动上方红色四角后，放大图会同步更新。`;
  E.rowCard.classList.remove('hidden');
}

function normalizeTrain(value){
  const digits=value.replace(/\D/g,'').slice(0,3);
  return digits?digits.padStart(3,'0'):'';
}

function normalizeTrack(value){return value.toUpperCase().replace(/\s+/g,'').slice(0,5)}

function duplicateIndexes(values){
  const groups=new Map();
  values.forEach((value,index)=>{if(value){const items=groups.get(value)??[];items.push(index);groups.set(value,items)}});
  const duplicates=new Set();
  for(const items of groups.values())if(items.length>1)items.forEach(index=>duplicates.add(index));
  return duplicates;
}

function validateEntries(){
  const trains=state.entries.map(item=>normalizeTrain(item.train)),tracks=state.entries.map(item=>normalizeTrack(item.track));
  const duplicateTrains=duplicateIndexes(trains),duplicateTracks=duplicateIndexes(tracks);
  let complete=0;
  E.batchRows.querySelectorAll('.batch-row').forEach((card,index)=>{
    const trainInput=card.querySelector('[data-field="train"]'),trackInput=card.querySelector('[data-field="track"]');
    trainInput.classList.toggle('duplicate',duplicateTrains.has(index));trackInput.classList.toggle('duplicate',duplicateTracks.has(index));
    trainInput.setAttribute('aria-invalid',String(duplicateTrains.has(index)));trackInput.setAttribute('aria-invalid',String(duplicateTracks.has(index)));
    const done=Boolean(trains[index]&&tracks[index]);if(done)complete++;
    const rowState=card.querySelector('.row-state');rowState.textContent=done?'已填写':'待填写';rowState.classList.toggle('complete',done);
  });
  const warnings=[];
  if(duplicateTrains.size)warnings.push(`发现 ${duplicateTrains.size} 行车号重复`);
  if(duplicateTracks.size)warnings.push(`发现 ${duplicateTracks.size} 行股道重复`);
  E.batchStatus.className=`batch-status ${warnings.length?'warning':complete===31?'good':''}`;
  E.batchStatus.textContent=`已填写 ${complete}/31 行。${warnings.length?warnings.join('；'):'未发现车号或股道重复。'}`;
}

function ensureBatchRows(){
  if(E.batchRows.children.length)return;
  const fragment=document.createDocumentFragment();
  for(let row=0;row<31;row++){
    const card=document.createElement('article');card.className='batch-row';card.dataset.row=String(row);
    const head=document.createElement('div');head.className='batch-row-head';
    const title=document.createElement('strong');title.textContent=`表号 ${31+row}`;
    const rowState=document.createElement('span');rowState.className='row-state';rowState.textContent='待填写';head.append(title,rowState);
    const canvas=document.createElement('canvas');canvas.className='batch-crop';canvas.addEventListener('click',()=>{state.selectedRow=row;draw()});
    const fields=document.createElement('div');fields.className='batch-fields';
    for(const [field,labelText,placeholder,inputMode] of [['train','车号','例如 027','numeric'],['track','股道','例如 13A','text']]){
      const label=document.createElement('label');label.textContent=labelText;
      const input=document.createElement('input');input.type='text';input.inputMode=inputMode;input.autocomplete='off';input.placeholder=placeholder;input.dataset.field=field;input.dataset.row=String(row);
      input.addEventListener('input',()=>{state.entries[row][field]=input.value;validateEntries()});
      input.addEventListener('blur',()=>{input.value=field==='train'?normalizeTrain(input.value):normalizeTrack(input.value);state.entries[row][field]=input.value;validateEntries()});
      label.append(input);fields.append(label);
    }
    card.append(head,canvas,fields);fragment.append(card);
  }
  E.batchRows.append(fragment);
}

function renderBatchRows(){
  if(!state.sourcePixels||!state.quad)return;
  ensureBatchRows();
  E.batchRows.querySelectorAll('.batch-row').forEach((card,row)=>{
    const canvas=card.querySelector('canvas'),context=canvas.getContext('2d');paintRowCrop(canvas,context,row,520,88,true);
  });
  E.batchCard.classList.remove('hidden');validateEntries();
}

function queueBatchRender(delay=100){
  clearTimeout(batchRenderTimer);batchRenderTimer=setTimeout(renderBatchRows,delay);
}

function resetEntries(){
  state.entries=Array.from({length:31},()=>({train:'',track:''}));
  E.batchRows.querySelectorAll('input').forEach(input=>{input.value='';input.classList.remove('duplicate')});
  if(E.batchRows.children.length)validateEntries();
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
  state.quad[state.dragCorner]={x:Math.max(0,Math.min(state.width,point.x)),y:Math.max(0,Math.min(state.height,point.y))};state.rowEdges=null;draw();
});
E.photoCanvas.addEventListener('pointerup',event=>{
  const point=canvasPoint(event),boundaryChanged=state.dragCorner>=0&&state.dragMoved;
  if(state.dragCorner<0&&!state.dragMoved){const row=rowAtPoint(point);if(row>=0){state.selectedRow=row;draw()}}
  state.dragCorner=-1;state.pointerStart=null;
  if(boundaryChanged)queueBatchRender();
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
    state.rowEdges=result.rowEdges?.length===32?result.rowEdges.map(edge=>({left:{x:edge.left.x*sx,y:edge.left.y*sy},right:{x:edge.right.x*sx,y:edge.right.y*sy}})):null;state.lastAutoRowEdges=cloneRowEdges(state.rowEdges);
    if(result.columns){
      state.carStart=result.columns.carStart;state.trackStart=result.columns.trackStart;
      state.lastAutoColumns={carStart:state.carStart,trackStart:state.trackStart};
      E.carStart.value=Math.round(state.carStart*100);E.trackStart.value=Math.round(state.trackStart*100);
      E.carStartValue.textContent=`${Math.round(state.carStart*100)}%`;E.trackStartValue.textContent=`${Math.round(state.trackStart*100)}%`;
    }
    confidenceLabel(result.confidence,result.debug);
    if(result.debug.usedNumberAnchors)setStatus('已按表号31—61逐行定位；弯折区域使用各行自己的边界。请重点抽查31—33行。');
    else if(result.confidence>=.78)setStatus('自动定位完成。请点击几行抽查，确认框线落在正确单元格。');
    else setStatus(`自动定位仅作初始参考：${result.debug.reason||'请拖动四角修正'}。`);
    draw();queueBatchRender(0);
  }catch(error){
    state.quad=fallbackQuad(state.width,state.height);state.rowStops=equalRowStops();state.lastAutoQuad=cloneQuad(state.quad);state.lastAutoRowStops=[...state.rowStops];confidenceLabel(0);
    setStatus('自动定位失败，已显示默认框；请拖动四角修正。'+(error?.message||''));draw();queueBatchRender(0);
  }finally{E.autoBtn.disabled=false}
}

async function loadFile(file){
  if(!file||!/^image\/(jpeg|png|webp)$/.test(file.type))return;
  const url=URL.createObjectURL(file),image=new Image();image.decoding='async';image.src=url;
  try{await image.decode()}catch{URL.revokeObjectURL(url);setStatus('照片读取失败。');return}
  const scale=Math.min(1,1800/Math.max(image.naturalWidth,image.naturalHeight));
  state.width=Math.max(1,Math.round(image.naturalWidth*scale));state.height=Math.max(1,Math.round(image.naturalHeight*scale));
  state.image=image;state.fileName=file.name;state.selectedRow=0;resetEntries();
  E.photoCanvas.width=state.width;E.photoCanvas.height=state.height;
  ctx.drawImage(image,0,0,state.width,state.height);state.sourcePixels=ctx.getImageData(0,0,state.width,state.height);
  E.workspace.classList.remove('hidden');E.rowCard.classList.remove('hidden');
  setStatus('照片只在本机浏览器中处理，不会上传。');
  await autoLocate();
  URL.revokeObjectURL(url);
}

E.imageInput.addEventListener('change',()=>loadFile(E.imageInput.files?.[0]));
E.autoBtn.addEventListener('click',autoLocate);
E.defaultBtn.addEventListener('click',()=>{if(!state.image)return;state.quad=fallbackQuad(state.width,state.height);state.rowStops=equalRowStops();state.rowEdges=null;confidenceLabel(0);setStatus('已使用默认框，请拖动四角到31行顶部和61行底部。');draw();queueBatchRender()});
E.resetBtn.addEventListener('click',()=>{if(!state.lastAutoQuad)return;state.quad=cloneQuad(state.lastAutoQuad);state.rowStops=state.lastAutoRowStops?[...state.lastAutoRowStops]:equalRowStops();state.rowEdges=cloneRowEdges(state.lastAutoRowEdges);if(state.lastAutoColumns){state.carStart=state.lastAutoColumns.carStart;state.trackStart=state.lastAutoColumns.trackStart;E.carStart.value=Math.round(state.carStart*100);E.trackStart.value=Math.round(state.trackStart*100);E.carStartValue.textContent=`${Math.round(state.carStart*100)}%`;E.trackStartValue.textContent=`${Math.round(state.trackStart*100)}%`;}setStatus('已恢复最近一次自动定位结果。');draw();queueBatchRender()});
E.previousRow.addEventListener('click',()=>{state.selectedRow=Math.max(0,state.selectedRow-1);draw()});
E.nextRow.addEventListener('click',()=>{state.selectedRow=Math.min(30,state.selectedRow+1);draw()});

function updateColumns(){
  state.carStart=Number(E.carStart.value)/100;state.trackStart=Number(E.trackStart.value)/100;
  if(state.trackStart<=state.carStart+.08){state.trackStart=state.carStart+.08;E.trackStart.value=Math.round(state.trackStart*100)}
  E.carStartValue.textContent=`${Math.round(state.carStart*100)}%`;E.trackStartValue.textContent=`${Math.round(state.trackStart*100)}%`;draw();queueBatchRender();
}
E.carStart.addEventListener('input',updateColumns);E.trackStart.addEventListener('input',updateColumns);

function nudgeEdge(edge,direction){
  if(!state.quad)return;
  state.rowEdges=null;
  const [leftTop,rightTop,rightBottom,leftBottom]=state.quad.map(point=>({...point}));
  if(edge==='top'){
    state.quad[0].x+=(leftBottom.x-leftTop.x)/31*direction;state.quad[0].y+=(leftBottom.y-leftTop.y)/31*direction;
    state.quad[1].x+=(rightBottom.x-rightTop.x)/31*direction;state.quad[1].y+=(rightBottom.y-rightTop.y)/31*direction;
  }else{
    state.quad[3].x+=(leftBottom.x-leftTop.x)/31*direction;state.quad[3].y+=(leftBottom.y-leftTop.y)/31*direction;
    state.quad[2].x+=(rightBottom.x-rightTop.x)/31*direction;state.quad[2].y+=(rightBottom.y-rightTop.y)/31*direction;
  }
  setStatus(`${edge==='top'?'31上边':'61下边'}已${direction>0?'下移':'上移'}一行。`);draw();queueBatchRender();
}
E.topUp.addEventListener('click',()=>nudgeEdge('top',-1));
E.topDown.addEventListener('click',()=>nudgeEdge('top',1));
E.bottomUp.addEventListener('click',()=>nudgeEdge('bottom',-1));
E.bottomDown.addEventListener('click',()=>nudgeEdge('bottom',1));
E.regenerateRows.addEventListener('click',()=>renderBatchRows());
E.clearRows.addEventListener('click',()=>{if(confirm('确定清空31行已填写的车号和股道吗？'))resetEntries()});
E.copyRows.addEventListener('click',async()=>{
  const text=[['表号','车号','股道'],...state.entries.map((item,index)=>[31+index,normalizeTrain(item.train),normalizeTrack(item.track)])].map(row=>row.join('\t')).join('\n');
  try{await navigator.clipboard.writeText(text);E.batchStatus.className='batch-status good';E.batchStatus.textContent='结果已复制，可粘贴到WPS或Excel。'}
  catch{window.prompt('复制下面的结果：',text)}
});
