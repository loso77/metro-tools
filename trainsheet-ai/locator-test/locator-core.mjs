const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

export function grayFromImageData(imageData){
  const {data,width,height}=imageData;
  const gray=new Uint8Array(width*height);
  for(let i=0,j=0;i<data.length;i+=4,j++)gray[j]=(data[i]*77+data[i+1]*150+data[i+2]*29)>>8;
  return gray;
}

function adaptiveMask(gray,width,height){
  const integral=new Uint32Array((width+1)*(height+1));
  for(let y=0;y<height;y++){
    let row=0;
    const src=y*width,dst=(y+1)*(width+1),prev=y*(width+1);
    for(let x=0;x<width;x++){
      row+=gray[src+x];
      integral[dst+x+1]=integral[prev+x+1]+row;
    }
  }
  const mask=new Uint8Array(width*height),radius=Math.max(8,Math.round(width/55));
  for(let y=0;y<height;y++){
    const y0=Math.max(0,y-radius),y1=Math.min(height-1,y+radius);
    for(let x=0;x<width;x++){
      const x0=Math.max(0,x-radius),x1=Math.min(width-1,x+radius);
      const a=y0*(width+1)+x0,b=y0*(width+1)+x1+1,c=(y1+1)*(width+1)+x0,d=(y1+1)*(width+1)+x1+1;
      const mean=(integral[d]-integral[b]-integral[c]+integral[a])/((x1-x0+1)*(y1-y0+1));
      const value=gray[y*width+x];
      if(value<Math.min(188,mean-9))mask[y*width+x]=1;
    }
  }
  return mask;
}

function darkPoints(mask,width,height){
  const points=[];
  for(let y=1;y<height-1;y++){
    const row=y*width;
    for(let x=1;x<width-1;x++)if(mask[row+x])points.push([x,y]);
  }
  return points;
}

function smoothProjection(input,radius=2){
  const output=new Float64Array(input.length),prefix=new Float64Array(input.length+1);
  for(let i=0;i<input.length;i++)prefix[i+1]=prefix[i]+input[i];
  for(let i=0;i<input.length;i++){
    const a=Math.max(0,i-radius),b=Math.min(input.length,i+radius+1);
    output[i]=(prefix[b]-prefix[a])/(b-a);
  }
  return output;
}

function findPeaks(values,start,end,minDistance){
  const raw=[];
  start=Math.max(1,Math.floor(start));end=Math.min(values.length-2,Math.ceil(end));
  for(let i=start;i<=end;i++)if(values[i]>=values[i-1]&&values[i]>values[i+1])raw.push({position:i,strength:values[i]});
  raw.sort((a,b)=>b.strength-a.strength);
  const selected=[];
  for(const peak of raw){
    if(selected.every(x=>Math.abs(x.position-peak.position)>=minDistance))selected.push(peak);
    if(selected.length>=120)break;
  }
  return selected;
}

function scoreTop(peaks,count){
  return peaks.slice(0,count).reduce((sum,x)=>sum+x.strength,0);
}

function verticalProjection(points,width,height,slope,minXRatio=.4){
  const values=new Uint32Array(width),midY=height/2;
  for(const [x,y] of points){
    if(x<width*minXRatio||x>width*.995||y<height*.07||y>height*.96)continue;
    const position=Math.round(x-slope*(y-midY));
    if(position>=0&&position<width)values[position]++;
  }
  return smoothProjection(values,Math.max(1,Math.round(width/500)));
}

function combinationsOfFive(items,visit){
  const n=items.length;
  for(let a=0;a<n-4;a++)for(let b=a+1;b<n-3;b++)for(let c=b+1;c<n-2;c++)for(let d=c+1;d<n-1;d++)for(let e=d+1;e<n;e++)visit([items[a],items[b],items[c],items[d],items[e]]);
}

function selectVerticalGrid(peaks,width,height,broad=false){
  const candidates=peaks.slice(0,broad?34:24).sort((a,b)=>a.position-b.position);
  const expected=[.15,.13,.31,.41];
  let best=null;
  combinationsOfFive(candidates,group=>{
    const x=group.map(p=>p.position),gridWidth=x[4]-x[0];
    if(gridWidth<width*.18||gridWidth>width*(broad?.62:.44)||x[0]<width*(broad?.01:.44)||x[4]<width*(broad?.35:.82)||x[4]>width*.995)return;
    const gaps=[x[1]-x[0],x[2]-x[1],x[3]-x[2],x[4]-x[3]];
    if(gaps.some(g=>g<width*.027))return;
    const ratios=gaps.map(g=>g/gridWidth);
    const ratioPenalty=ratios.reduce((sum,r,i)=>sum+Math.abs(r-expected[i]),0);
    const strength=group.reduce((sum,p)=>sum+p.strength,0)/(height*5);
    const widthScore=1-Math.min(1,Math.abs(gridWidth/width-(broad?.36:.29))/(broad?.3:.2));
    const rightScore=broad?0:clamp((x[4]/width-.72)/.27,0,1);
    const leftScore=broad?0:clamp((x[0]/width-.44)/.24,0,1);
    const score=strength*4+widthScore+rightScore*2+leftScore*.9-ratioPenalty*2.4;
    if(!best||score>best.score)best={score,group,x,ratios};
  });
  return best;
}

function horizontalProjection(points,width,height,slope,left,right,leftVerticalSlope,rightVerticalSlope=leftVerticalSlope){
  const values=new Uint32Array(height),midX=(left+right)/2,midY=height/2;
  for(const [x,y] of points){
    if(y<height*.05||y>height*.98)continue;
    const leftAtY=left+leftVerticalSlope*(y-midY),rightAtY=right+rightVerticalSlope*(y-midY);
    if(x<leftAtY-3||x>rightAtY+3)continue;
    const position=Math.round(y-slope*(x-midX));
    if(position>=0&&position<height)values[position]++;
  }
  return smoothProjection(values,Math.max(1,Math.round(height/700)));
}

function verticalLineExtent(mask,width,height,xAtMid,slope){
  const midY=height/2,raw=new Float64Array(height),radius=Math.max(2,Math.round(width/300));
  for(let y=0;y<height;y++){
    const x=Math.round(xAtMid+slope*(y-midY));
    let value=0;
    for(let dx=-radius;dx<=radius;dx++)if(x+dx>=0&&x+dx<width)value+=mask[y*width+x+dx];
    raw[y]=value;
  }
  const smooth=smoothProjection(raw,Math.max(4,Math.round(height/180)));
  const max=Math.max(...smooth),threshold=Math.max(.22,max*.16),maxGap=Math.max(10,Math.round(height*.012));
  let best=null,start=-1,last=-1,gap=0,support=0;
  for(let y=Math.round(height*.04);y<Math.round(height*.99);y++){
    if(smooth[y]>=threshold){
      if(start<0){start=y;support=0}
      last=y;gap=0;support+=smooth[y];
    }else if(start>=0&&gap++>maxGap){
      const end=last,length=end-start;
      if(length>height*.25){const score=length+support/Math.max(1,length)*20;if(!best||score>best.score)best={start,end,score,threshold,max}}
      start=-1;last=-1;gap=0;support=0;
    }
  }
  if(start>=0&&last>start){const length=last-start,score=length+support/Math.max(1,length)*20;if(length>height*.25&&(!best||score>best.score))best={start,end:last,score,threshold,max}}
  return best;
}

function selectPerspectiveVerticalGrid(points,mask,width,height){
  const binSize=Math.max(5,Math.round(width*.008)),bins=new Map();
  for(let slope=-.25;slope<=.2501;slope+=.0125){
    const projection=verticalProjection(points,width,height,slope,.01);
    const peaks=findPeaks(projection,width*.01,width*.82,Math.max(5,width*.009)).slice(0,18);
    for(const peak of peaks){
      const key=Math.round(peak.position/binSize),items=bins.get(key)??[];
      items.push({...peak,slope});items.sort((a,b)=>b.strength-a.strength);bins.set(key,items.slice(0,4));
    }
  }
  const candidates=[];
  for(const items of bins.values()){
    let best=null;
    for(const item of items){
      const extent=verticalLineExtent(mask,width,height,item.position,item.slope);if(!extent)continue;
      const length=extent.end-extent.start,quality=length/height*3+item.strength/height;
      if(length>height*.34&&(!best||quality>best.quality))best={...item,extent,length,quality};
    }
    if(best)candidates.push(best);
  }
  const pool=candidates.sort((a,b)=>b.quality-a.quality).slice(0,32).sort((a,b)=>a.position-b.position);
  const templates=[[.15,.13,.31,.41],[.19,.12,.35,.34]];let best=null;
  combinationsOfFive(pool,group=>{
    const x=group.map(item=>item.position),gridWidth=x[4]-x[0];
    if(gridWidth<width*.36||gridWidth>width*.66||x[4]<width*.48||x[4]>width*.78)return;
    const gaps=[x[1]-x[0],x[2]-x[1],x[3]-x[2],x[4]-x[3]];if(gaps.some(g=>g<width*.045))return;
    const ratios=gaps.map(g=>g/gridWidth),ratioPenalty=Math.min(...templates.map(template=>ratios.reduce((sum,ratio,index)=>sum+Math.abs(ratio-template[index]),0)));
    const coverage=group.reduce((sum,item)=>sum+item.length/height,0)/5;
    const strength=group.reduce((sum,item)=>sum+Math.min(1,item.strength/height),0)/5;
    const widthScore=1-Math.min(1,Math.abs(gridWidth/width-.47)/.2);
    let slopePenalty=0;for(let index=0;index<4;index++)slopePenalty+=Math.max(0,group[index].slope-group[index+1].slope-.04);
    const score=coverage*5+strength+widthScore-ratioPenalty*5-slopePenalty*3;
    if(!best||score>best.score)best={score,group,x,ratios};
  });
  return best;
}

function selectNumberAnchorSequence(mask,width,height,verticalLines,verticalSlopes,quad){
  const raw=new Float64Array(height),midY=height/2;
  for(let y=0;y<height;y++){
    const left=verticalLines[0]+verticalSlopes[0]*(y-midY),right=verticalLines[1]+verticalSlopes[1]*(y-midY);
    const gap=right-left,x0=Math.round(left+gap*.16),x1=Math.round(right-gap*.14);let ink=0;
    for(let x=clamp(x0,0,width-1);x<=clamp(x1,0,width-1);x++)ink+=mask[y*width+x];
    const span=Math.max(1,x1-x0+1);raw[y]=ink/span>.48?0:ink;
  }
  const signal=smoothProjection(raw,Math.max(2,Math.round(height/500))),allPeaks=[];
  for(let y=2;y<height-2;y++)if(signal[y]>=signal[y-1]&&signal[y]>signal[y+1])allPeaks.push({y,value:signal[y]});
  allPeaks.sort((a,b)=>b.value-a.value);
  const peaks=[],minimumDistance=Math.max(9,Math.round(height/100));
  for(const peak of allPeaks){
    if(peaks.every(item=>Math.abs(item.y-peak.y)>minimumDistance))peaks.push(peak);
    if(peaks.length>=80)break;
  }
  peaks.sort((a,b)=>a.y-b.y);
  const top=(quad[0].y+quad[1].y)/2,bottom=(quad[2].y+quad[3].y)/2,baseStep=(bottom-top)/31,maxValue=Math.max(1,...peaks.map(item=>item.value));
  let best=null;
  for(let scale=.76;scale<=1.101;scale+=.02){
    const step=baseStep*scale,minGap=step*.55,maxGap=step*1.48;
    const candidates=peaks.filter(item=>item.y>=Math.max(0,top-step*.6)&&item.y<=Math.min(height-1,bottom+step*.25));
    const scores=Array.from({length:31},()=>new Float64Array(candidates.length).fill(-1e9));
    const previous=Array.from({length:31},()=>new Int16Array(candidates.length).fill(-1));
    for(let j=0;j<candidates.length;j++){
      const item=candidates[j];if(item.y>top+step*2.6)continue;
      scores[0][j]=item.value/maxValue*3-Math.abs(item.y-(top+step*.5))/step*.35;
    }
    for(let index=1;index<31;index++)for(let j=0;j<candidates.length;j++){
      const item=candidates[j],evidence=item.value/maxValue;
      for(let i=0;i<j;i++){
        const gap=item.y-candidates[i].y;if(gap<minGap||gap>maxGap)continue;
        const score=scores[index-1][i]+evidence*3-Math.abs(gap-step)/step*1.8;
        if(score>scores[index][j]){scores[index][j]=score;previous[index][j]=i}
      }
    }
    for(let j=0;j<candidates.length;j++){
      const score=scores[30][j]-Math.abs(candidates[j].y-(bottom-step*.5))/step*5;if(score<-1e8)continue;
      if(!best||score>best.score){
        const sequence=[];let candidateIndex=j;
        for(let index=30;index>=0;index--){sequence.push(candidates[candidateIndex]);candidateIndex=previous[index][candidateIndex]}
        sequence.reverse();best={score,step,sequence};
      }
    }
  }
  if(!best||best.score<52)return null;
  const centers=best.sequence.map(item=>item.y),boundaries=[centers[0]-(centers[1]-centers[0])/2];
  for(let index=1;index<centers.length;index++)boundaries.push((centers[index-1]+centers[index])/2);
  boundaries.push(centers.at(-1)+(centers.at(-1)-centers.at(-2))/2);
  return {score:best.score,centers,boundaries:boundaries.map(value=>clamp(value,0,height-1))};
}

function traceNumberRowEdges(mask,width,height,anchors,verticalLines,verticalSlopes){
  const midY=height/2;
  const candidateRows=anchors.boundaries.map((boundary,index)=>{
    const previousBoundary=anchors.boundaries[Math.max(0,index-1)],nextBoundary=anchors.boundaries[Math.min(31,index+1)];
    const localStep=Math.max(12,(nextBoundary-previousBoundary)/(index===0||index===31?1:2));
    const left=verticalLines[0]+verticalSlopes[0]*(boundary-midY),right=verticalLines[4]+verticalSlopes[4]*(boundary-midY);
    const numberLeft=verticalLines[0]+verticalSlopes[0]*(boundary-midY),numberRight=verticalLines[1]+verticalSlopes[1]*(boundary-midY),anchorX=(numberLeft+numberRight)/2;
    const candidates=[];
    for(let offset=-localStep*.2;offset<=localStep*.201;offset+=1)for(let slope=-.3;slope<=.301;slope+=.01){
      let hits=0,run=0,longest=0,samples=0;
      for(let x=Math.round(left);x<=Math.round(right);x+=2){
        const y=Math.round(boundary+offset+slope*(x-anchorX));let hit=0;
        for(let dy=-1;dy<=1;dy++)if(y+dy>=0&&y+dy<height&&x>=0&&x<width)hit=Math.max(hit,mask[(y+dy)*width+x]);
        if(hit){hits++;run++;longest=Math.max(longest,run)}else run=0;samples++;
      }
      const score=hits/Math.max(1,samples)+longest/Math.max(1,samples)*.35-Math.abs(offset)/localStep*.28;
      candidates.push({score,slope,left:{x:left,y:boundary+offset+slope*(left-anchorX)},right:{x:right,y:boundary+offset+slope*(right-anchorX)}});
    }
    candidates.sort((a,b)=>b.score-a.score);const diverse=[];
    for(const candidate of candidates){
      if(diverse.every(item=>Math.abs(item.left.y-candidate.left.y)>2||Math.abs(item.right.y-candidate.right.y)>2))diverse.push(candidate);
      if(diverse.length>=48)break;
    }
    return diverse;
  });
  const scores=candidateRows.map(row=>new Float64Array(row.length).fill(-1e9)),previous=candidateRows.map(row=>new Int16Array(row.length).fill(-1));
  for(let index=0;index<candidateRows[0].length;index++)scores[0][index]=candidateRows[0][index].score*5;
  for(let row=1;row<candidateRows.length;row++){
    const expectedGap=anchors.boundaries[row]-anchors.boundaries[row-1],minGap=expectedGap*.35,maxGap=expectedGap*1.8;
    for(let j=0;j<candidateRows[row].length;j++)for(let i=0;i<candidateRows[row-1].length;i++){
      const current=candidateRows[row][j],prior=candidateRows[row-1][i],leftGap=current.left.y-prior.left.y,rightGap=current.right.y-prior.right.y;
      if(leftGap<minGap||rightGap<minGap||leftGap>maxGap||rightGap>maxGap)continue;
      const gapPenalty=(Math.abs(leftGap-expectedGap)+Math.abs(rightGap-expectedGap))/Math.max(1,expectedGap)*.45;
      const score=scores[row-1][i]+current.score*5-gapPenalty-Math.abs(current.slope-prior.slope)*1.2;
      if(score>scores[row][j]){scores[row][j]=score;previous[row][j]=i}
    }
  }
  const last=scores.length-1;let bestIndex=-1,bestScore=-1e9;
  for(let index=0;index<scores[last].length;index++)if(scores[last][index]>bestScore){bestScore=scores[last][index];bestIndex=index}
  if(bestIndex<0)return null;
  const selected=[];
  for(let row=last;row>=0;row--){selected.push(candidateRows[row][bestIndex]);bestIndex=previous[row][bestIndex]}
  return selected.reverse().map(item=>({left:item.left,right:item.right}));
}

function nearestPeak(sorted,value,tolerance){
  let lo=0,hi=sorted.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(sorted[mid].position<value)lo=mid+1;else hi=mid;}
  let best=null;
  for(const index of [lo-1,lo,lo+1]){
    const candidate=sorted[index];
    if(!candidate)continue;
    const distance=Math.abs(candidate.position-value);
    if(distance<=tolerance&&(!best||distance<best.distance))best={...candidate,distance};
  }
  return best;
}

function fitSequence(matches){
  const n=matches.length;
  if(n<2)return null;
  let sx=0,sy=0,sxx=0,sxy=0;
  for(const item of matches){sx+=item.k;sy+=item.position;sxx+=item.k*item.k;sxy+=item.k*item.position;}
  const denominator=n*sxx-sx*sx;
  if(!denominator)return null;
  const step=(n*sxy-sx*sy)/denominator;
  const start=(sy-step*sx)/n;
  return {start,step};
}

function selectHorizontalGrid(peaks,height){
  const candidates=peaks.filter(p=>p.strength>0).sort((a,b)=>a.position-b.position);
  const strongest=Math.max(1,...candidates.map(x=>x.strength));
  const minStep=Math.max(8,height/150),maxStep=Math.min(58,height/18);
  let best=null;
  for(const startPeak of candidates){
    if(startPeak.position<height*.06||startPeak.position>height*.82)continue;
    for(let step=minStep;step<=maxStep;step+=.5){
      const bottom=startPeak.position+31*step;
      if(bottom>height*.985)break;
      const tolerance=Math.max(2.2,step*.2),matches=[];
      let strength=0;
      for(let k=0;k<32;k++){
        const found=nearestPeak(candidates,startPeak.position+k*step,tolerance);
        if(found){matches.push({k,...found});strength+=found.strength/strongest;}
      }
      if(matches.length<19)continue;
      const fit=fitSequence(matches);if(!fit||fit.step<minStep*.8||fit.step>maxStep*1.2)continue;
      const refinedBottom=fit.start+31*fit.step;
      const bottomBonus=refinedBottom/height;
      const score=matches.length*12+strength*2+bottomBonus*2.5-Math.abs(fit.step-step)*2;
      if(!best||score>best.score)best={score,matches:matches.length,start:fit.start,step:fit.step,bottom:refinedBottom,strength};
    }
  }
  return best;
}

function lineIntersection(horizontalY,horizontalSlope,verticalX,verticalSlope,midX,midY){
  const denominator=1-horizontalSlope*verticalSlope;
  const y=(horizontalY+horizontalSlope*(verticalX-verticalSlope*midY-midX))/denominator;
  return {x:verticalX+verticalSlope*(y-midY),y};
}

function snapRowStops(peaks,top,bottom){
  const sorted=peaks.filter(p=>p.strength>0).sort((a,b)=>a.position-b.position);
  const step=(bottom-top)/31,positions=[top];
  for(let k=1;k<31;k++){
    const expected=top+step*k,found=nearestPeak(sorted,expected,Math.max(3,step*.38));
    const minimum=positions[k-1]+step*.62,maximum=bottom-step*(31-k)*.62;
    positions.push(clamp(found?.position??expected,minimum,maximum));
  }
  positions.push(bottom);
  return positions.map(position=>(position-top)/(bottom-top));
}

function strongestPeakNear(sorted,target,tolerance,strongest){
  let best=null;
  for(const candidate of sorted){
    if(candidate.position<target-tolerance)continue;
    if(candidate.position>target+tolerance)break;
    const distance=Math.abs(candidate.position-target);
    const score=candidate.strength/strongest-distance/tolerance*.32;
    if(!best||score>best.score)best={...candidate,distance,score};
  }
  return best;
}

function selectBottomAnchoredGrid(peaks,height,extent,headerStart,referenceStep,minHeaderRows=.8){
  if(!extent||!Number.isFinite(headerStart))return null;
  const sorted=peaks.filter(p=>p.strength>0).sort((a,b)=>a.position-b.position);
  const strongest=Math.max(1,...sorted.map(item=>item.strength));
  const bottoms=sorted.filter(item=>item.position>=extent.end-referenceStep*1.35&&item.position<=Math.min(height*.99,extent.end+referenceStep*.75));
  let best=null,ranked=[];
  for(const bottomPeak of bottoms){
    for(let headerRows=minHeaderRows;headerRows<=2.41;headerRows+=.1){
      const step=(bottomPeak.position-headerStart)/(31+headerRows);
      if(step<Math.max(12,referenceStep*.66)||step>Math.min(52,referenceStep*1.04))continue;
      const tolerance=Math.max(3,step*.24),matches=[];let strength=0;
      for(let k=0;k<32;k++){
        const target=bottomPeak.position-k*step,found=strongestPeakNear(sorted,target,tolerance,strongest);
        if(found){matches.push({k,...found});strength+=found.strength/strongest}
      }
      if(matches.length<27)continue;
      const top=bottomPeak.position-31*step;
      if(top<height*.06||top>height*.45)continue;
      const extentDistance=Math.abs(bottomPeak.position-extent.end)/Math.max(1,referenceStep);
      const earlyBottomPenalty=Math.max(0,extent.end-bottomPeak.position)/Math.max(1,referenceStep);
      const stepDistance=Math.abs(step-referenceStep)/Math.max(1,referenceStep);
      const bottomStrength=bottomPeak.strength/strongest;
      const score=matches.length*10+strength*2.4+bottomStrength*4-extentDistance*3-earlyBottomPenalty*1.2-stepDistance*2-Math.abs(headerRows-2)*.5;
      const candidate={score,top,bottom:bottomPeak.position,step,matches:matches.length,strength,extentDistance,headerRows};
      ranked.push(candidate);
      if(!best||score>best.score)best=candidate;
    }
  }
  if(best){
    const eligible=ranked.filter(item=>item.score>=best.score-25&&item.matches>=best.matches-2);
    eligible.sort((a,b)=>{
      const distanceDifference=a.extentDistance-b.extentDistance;
      if(Math.abs(distanceDifference)>.045)return distanceDifference;
      const aAfter=a.bottom>=extent.end,bAfter=b.bottom>=extent.end;
      if(aAfter!==bAfter)return aAfter?-1:1;
      return b.score-a.score;
    });
    best=eligible[0]??best;
  }
  return best;
}

export function fallbackQuad(width,height){
  return [
    {x:width*.59,y:height*.15},
    {x:width*.94,y:height*.15},
    {x:width*.94,y:height*.86},
    {x:width*.59,y:height*.86}
  ];
}

export function detectTargetGridFromGray(gray,width,height){
  if(!(gray instanceof Uint8Array)||gray.length!==width*height)throw new Error('灰度图尺寸不正确');
  const mask=adaptiveMask(gray,width,height),points=darkPoints(mask,width,height);
  if(points.length<width*height*.008)return {points:fallbackQuad(width,height),confidence:0,debug:{reason:'照片线条不足'}};

  let bestVertical=null;
  for(let slope=-.2;slope<=.2001;slope+=.0125){
    const projection=verticalProjection(points,width,height,slope);
    const peaks=findPeaks(projection,width*.4,width*.995,Math.max(5,width*.009));
    const score=scoreTop(peaks,12);
    if(!bestVertical||score>bestVertical.score)bestVertical={score,slope,projection,peaks};
  }
  let verticalGrid=selectVerticalGrid(bestVertical.peaks,width,height);
  if(!verticalGrid)return {points:fallbackQuad(width,height),confidence:.08,debug:{reason:'没有找到五条目标竖线',verticalSlope:bestVertical.slope}};

  let verticalLines=[...verticalGrid.x];
  if(Math.abs(bestVertical.slope)>.045){
    const gridWidth=verticalLines[4]-verticalLines[0];
    const preceding=bestVertical.peaks
      .filter(item=>item.position>=verticalLines[0]-gridWidth*.28&&item.position<=verticalLines[0]-gridWidth*.08)
      .sort((a,b)=>b.strength-a.strength)[0];
    if(preceding)verticalLines=[preceding.position,verticalLines[0],verticalLines[1],verticalLines[3],verticalLines[4]];
  }
  let usedBroadGrid=false,individualVerticalSlopes=null;
  let lineExtents=verticalLines.map(x=>verticalLineExtent(mask,width,height,x,bestVertical.slope));
  if(lineExtents.filter(Boolean).length<3){
    const perspectiveGrid=selectPerspectiveVerticalGrid(points,mask,width,height);
    if(perspectiveGrid){
      verticalGrid=perspectiveGrid;
      verticalLines=[...perspectiveGrid.x];
      individualVerticalSlopes=perspectiveGrid.group.map(item=>item.slope);
      lineExtents=perspectiveGrid.group.map(item=>item.extent);
      usedBroadGrid=true;
    }
    let broadVertical=null;
    for(let slope=-.24;slope<=.2401;slope+=.0125){
      const projection=verticalProjection(points,width,height,slope,.01);
      const peaks=findPeaks(projection,width*.01,width*.995,Math.max(5,width*.009));
      const score=scoreTop(peaks,16);
      if(!broadVertical||score>broadVertical.score)broadVertical={score,slope,projection,peaks};
    }
    const broadGrid=selectVerticalGrid(broadVertical.peaks,width,height,true);
    if(broadGrid){
      const broadExtents=broadGrid.x.map(x=>verticalLineExtent(mask,width,height,x,broadVertical.slope));
      const broadMinimumLength=Math.min(...broadExtents.map(item=>item?item.end-item.start:0));
      if(broadMinimumLength>=height*.43||(!individualVerticalSlopes&&broadExtents.filter(Boolean).length>lineExtents.filter(Boolean).length)){
        bestVertical=broadVertical;verticalGrid=broadGrid;verticalLines=[...broadGrid.x];lineExtents=broadExtents;usedBroadGrid=true;individualVerticalSlopes=null;
      }
    }
  }

  const extentLength=item=>item?item.end-item.start:0;
  if(usedBroadGrid&&!individualVerticalSlopes&&lineExtents.filter(item=>item&&item.start<height*.08).length>=2&&lineExtents.slice(1,3).some(item=>item&&item.start>height*.24)){
    const gridWidth=verticalLines[4]-verticalLines[0];
    const preceding=bestVertical.peaks
      .filter(item=>item.position>=verticalLines[0]-gridWidth*.34&&item.position<=verticalLines[0]-gridWidth*.06)
      .sort((a,b)=>b.strength-a.strength)[0];
    if(preceding){
      verticalLines=[preceding.position,verticalLines[0],verticalLines[1],verticalLines[3],verticalLines[4]];
      lineExtents=verticalLines.map(x=>verticalLineExtent(mask,width,height,x,bestVertical.slope));
    }
  }
  const nonZeroLengths=lineExtents.map(extentLength).filter(Boolean).sort((a,b)=>a-b);
  const typicalLength=nonZeroLengths[Math.floor(nonZeroLengths.length/2)]||0;
  if(typicalLength&&!individualVerticalSlopes){
    const gridWidth=verticalLines[4]-verticalLines[0];
    if(extentLength(lineExtents[2])<typicalLength*.68){
      const preceding=bestVertical.peaks
        .filter(item=>item.position>=verticalLines[0]-gridWidth*.3&&item.position<=verticalLines[0]-gridWidth*.07)
        .sort((a,b)=>b.strength-a.strength)[0];
      if(preceding)verticalLines=[preceding.position,verticalLines[0],verticalLines[1],verticalLines[3],verticalLines[4]];
    }else if(extentLength(lineExtents[0])<typicalLength*.62){
      const inner=bestVertical.peaks
        .filter(item=>item.position>verticalLines[2]+(verticalLines[3]-verticalLines[2])*.16&&item.position<verticalLines[3]-(verticalLines[3]-verticalLines[2])*.16)
        .sort((a,b)=>b.strength-a.strength)[0];
      if(inner)verticalLines=[verticalLines[1],verticalLines[2],inner.position,verticalLines[3],verticalLines[4]];
    }
    lineExtents=verticalLines.map(x=>verticalLineExtent(mask,width,height,x,bestVertical.slope));
  }
  const left=verticalLines[0],right=verticalLines[4];
  const leftVerticalSlope=individualVerticalSlopes?.[0]??bestVertical.slope;
  const rightVerticalSlope=individualVerticalSlopes?.[4]??bestVertical.slope;
  const perspectiveMagnitude=individualVerticalSlopes?Math.max(...individualVerticalSlopes.map(Math.abs)):Math.abs(bestVertical.slope);
  let bestHorizontal=null;
  for(let slope=-.22;slope<=.2201;slope+=.01){
    const projection=horizontalProjection(points,width,height,slope,left,right,leftVerticalSlope,rightVerticalSlope);
    const peaks=findPeaks(projection,height*.04,height*.99,Math.max(4,height*.005));
    const score=scoreTop(peaks,44);
    if(!bestHorizontal||score>bestHorizontal.score)bestHorizontal={score,slope,projection,peaks};
  }
  const horizontalGrid=selectHorizontalGrid(bestHorizontal.peaks,height);
  if(!horizontalGrid)return {points:fallbackQuad(width,height),confidence:.12,debug:{reason:'没有找到连续31行',verticalSlope:bestVertical.slope,verticalLines:verticalGrid.x}};

  const usableExtents=lineExtents.filter(Boolean);
  const extentStarts=usableExtents.map(item=>item.start).sort((a,b)=>a-b);
  const extentEnds=usableExtents.map(item=>item.end).sort((a,b)=>a-b);
  const largestEnd=extentEnds[extentEnds.length-1],secondLargestEnd=extentEnds[Math.max(0,extentEnds.length-2)];
  const extent=usableExtents.length?{
    start:extentStarts[Math.min(1,extentStarts.length-1)],
    end:largestEnd-secondLargestEnd<=height*.035?largestEnd:secondLargestEnd
  }:null;
  const headerStart=extentStarts[Math.min(1,extentStarts.length-1)];
  let anchoredGrid=selectBottomAnchoredGrid(bestHorizontal.peaks,height,extent,headerStart,horizontalGrid.step);
  if(!usedBroadGrid&&anchoredGrid&&anchoredGrid.matches<=30&&anchoredGrid.headerRows<1.2){
    const belowHeader=selectBottomAnchoredGrid(bestHorizontal.peaks,height,extent,headerStart,horizontalGrid.step,1.7);
    if(belowHeader&&belowHeader.matches>=anchoredGrid.matches-1&&belowHeader.extentDistance<.75)anchoredGrid=belowHeader;
  }
  let top=horizontalGrid.start,bottom=horizontalGrid.bottom,bottomExtension=0,topCorrection=0;
  if(anchoredGrid){
    top=anchoredGrid.top;bottom=anchoredGrid.bottom;
    if(extent&&anchoredGrid.extentDistance>.8){
      const sortedPeaks=bestHorizontal.peaks.filter(item=>item.strength>0).sort((a,b)=>a.position-b.position);
      const nextBottom=nearestPeak(sortedPeaks,bottom+anchoredGrid.step,anchoredGrid.step*.42);
      if(nextBottom&&Math.abs(nextBottom.position-extent.end)<Math.abs(bottom-extent.end))bottom=nextBottom.position;
    }
    if(perspectiveMagnitude>.045){
      const sortedPeaks=bestHorizontal.peaks.filter(item=>item.strength>0).sort((a,b)=>a.position-b.position);
      const perspectiveTop=nearestPeak(sortedPeaks,top-anchoredGrid.step*.75,anchoredGrid.step*.32);
      if(perspectiveTop)top=perspectiveTop.position;
    }
    bottomExtension=bottom-horizontalGrid.bottom;topCorrection=top-horizontalGrid.start;
  }else if(extent){
    const extension=extent.end-bottom;
    if(extension>horizontalGrid.step*.55&&extent.end<height*.99){
      bottomExtension=Math.min(extension,horizontalGrid.step*5);
      bottom+=bottomExtension;
      if(perspectiveMagnitude>.045&&bottomExtension>horizontalGrid.step*2.5){
        topCorrection=bottomExtension*.5;
        top+=topCorrection;
      }
    }
    const headerBasedTop=extent.start+horizontalGrid.step;
    if(headerBasedTop>top+horizontalGrid.step*.55&&headerBasedTop<bottom-horizontalGrid.step*25){
      topCorrection+=headerBasedTop-top;
      top=headerBasedTop;
    }
    if(top<height*.04||bottom>height*.99||bottom-top<height*.42){
      top=horizontalGrid.start;bottom=horizontalGrid.bottom;bottomExtension=0;topCorrection=0;
    }
  }
  if(usedBroadGrid){top=0;topCorrection=top-horizontalGrid.start}
  if(usedBroadGrid&&bottom>height*.94){bottom=height-1;bottomExtension=bottom-horizontalGrid.bottom}
  let rowStops=snapRowStops(bestHorizontal.peaks,top,bottom);
  const gridWidth=right-left;
  const columns={
    carStart:clamp((verticalLines[2]-left)/gridWidth,.24,.42),
    trackStart:clamp((verticalLines[3]-left)/gridWidth,.52,.76)
  };
  const midX=(left+right)/2,midY=height/2;
  let quad=[
    lineIntersection(top,bestHorizontal.slope,left,leftVerticalSlope,midX,midY),
    lineIntersection(top,bestHorizontal.slope,right,rightVerticalSlope,midX,midY),
    lineIntersection(bottom,bestHorizontal.slope,right,rightVerticalSlope,midX,midY),
    lineIntersection(bottom,bestHorizontal.slope,left,leftVerticalSlope,midX,midY)
  ].map(p=>({x:clamp(p.x,0,width-1),y:clamp(p.y,0,height-1)}));

  const resolvedVerticalSlopes=individualVerticalSlopes??verticalLines.map(()=>bestVertical.slope);
  const numberAnchors=selectNumberAnchorSequence(mask,width,height,verticalLines,resolvedVerticalSlopes,quad);
  const rowEdges=numberAnchors?traceNumberRowEdges(mask,width,height,numberAnchors,verticalLines,resolvedVerticalSlopes):null;
  if(rowEdges?.length===32){
    quad=[rowEdges[0].left,rowEdges[0].right,rowEdges[31].right,rowEdges[31].left];
    rowStops=Array.from({length:32},(_,index)=>index/31);
  }

  const rowConfidence=horizontalGrid.matches/32;
  const lineStrength=clamp(verticalGrid.group.reduce((s,p)=>s+p.strength,0)/(height*1.2),0,1);
  const adjustmentRows=(Math.abs(bottomExtension)+Math.abs(topCorrection))/Math.max(1,horizontalGrid.step);
  const confidence=clamp(rowConfidence*.75+lineStrength*.25-Math.min(.5,adjustmentRows*.12),0,1);
  return {points:quad,rowStops,rowEdges,columns,confidence,debug:{reason:'ok',rowMatches:rowEdges?.length??anchoredGrid?.matches??horizontalGrid.matches,rowStep:anchoredGrid?.step??horizontalGrid.step,bottomExtension,topCorrection,usedBroadGrid,usedPerspectiveGrid:Boolean(individualVerticalSlopes),usedNumberAnchors:Boolean(rowEdges),numberAnchorScore:numberAnchors?.score??null,numberAnchorCenters:numberAnchors?.centers??null,gridExtent:extent?{start:extent.start,end:extent.end}:null,headerStart,anchoredGrid:anchoredGrid?{matches:anchoredGrid.matches,step:anchoredGrid.step,extentDistance:anchoredGrid.extentDistance,headerRows:anchoredGrid.headerRows}:null,lineExtents:lineExtents.map(item=>item?{start:item.start,end:item.end}:null),horizontalSlope:bestHorizontal.slope,verticalSlope:bestVertical.slope,verticalSlopes:resolvedVerticalSlopes,verticalLines}};
}

export function detectTargetGrid(imageData){
  return detectTargetGridFromGray(grayFromImageData(imageData),imageData.width,imageData.height);
}

export function quadPoint(quad,u,v){
  const top={x:quad[0].x+(quad[1].x-quad[0].x)*u,y:quad[0].y+(quad[1].y-quad[0].y)*u};
  const bottom={x:quad[3].x+(quad[2].x-quad[3].x)*u,y:quad[3].y+(quad[2].y-quad[3].y)*u};
  return {x:top.x+(bottom.x-top.x)*v,y:top.y+(bottom.y-top.y)*v};
}
