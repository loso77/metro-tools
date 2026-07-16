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

function verticalProjection(points,width,height,slope){
  const values=new Uint32Array(width),midY=height/2;
  for(const [x,y] of points){
    if(x<width*.4||x>width*.995||y<height*.07||y>height*.96)continue;
    const position=Math.round(x-slope*(y-midY));
    if(position>=0&&position<width)values[position]++;
  }
  return smoothProjection(values,Math.max(1,Math.round(width/500)));
}

function combinationsOfFive(items,visit){
  const n=items.length;
  for(let a=0;a<n-4;a++)for(let b=a+1;b<n-3;b++)for(let c=b+1;c<n-2;c++)for(let d=c+1;d<n-1;d++)for(let e=d+1;e<n;e++)visit([items[a],items[b],items[c],items[d],items[e]]);
}

function selectVerticalGrid(peaks,width,height){
  const candidates=peaks.slice(0,24).sort((a,b)=>a.position-b.position);
  const expected=[.15,.13,.31,.41];
  let best=null;
  combinationsOfFive(candidates,group=>{
    const x=group.map(p=>p.position),gridWidth=x[4]-x[0];
    if(gridWidth<width*.18||gridWidth>width*.44||x[0]<width*.44||x[4]<width*.82||x[4]>width*.995)return;
    const gaps=[x[1]-x[0],x[2]-x[1],x[3]-x[2],x[4]-x[3]];
    if(gaps.some(g=>g<width*.027))return;
    const ratios=gaps.map(g=>g/gridWidth);
    const ratioPenalty=ratios.reduce((sum,r,i)=>sum+Math.abs(r-expected[i]),0);
    const strength=group.reduce((sum,p)=>sum+p.strength,0)/(height*5);
    const widthScore=1-Math.min(1,Math.abs(gridWidth/width-.29)/.2);
    const rightScore=clamp((x[4]/width-.72)/.27,0,1);
    const leftScore=clamp((x[0]/width-.44)/.24,0,1);
    const score=strength*4+widthScore+rightScore*2+leftScore*.9-ratioPenalty*2.4;
    if(!best||score>best.score)best={score,group,x,ratios};
  });
  return best;
}

function horizontalProjection(points,width,height,slope,left,right,verticalSlope){
  const values=new Uint32Array(height),midX=(left+right)/2,midY=height/2;
  for(const [x,y] of points){
    if(y<height*.05||y>height*.98)continue;
    const leftAtY=left+verticalSlope*(y-midY),rightAtY=right+verticalSlope*(y-midY);
    if(x<leftAtY-3||x>rightAtY+3)continue;
    const position=Math.round(y-slope*(x-midX));
    if(position>=0&&position<height)values[position]++;
  }
  return smoothProjection(values,Math.max(1,Math.round(height/700)));
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
  const verticalGrid=selectVerticalGrid(bestVertical.peaks,width,height);
  if(!verticalGrid)return {points:fallbackQuad(width,height),confidence:.08,debug:{reason:'没有找到五条目标竖线',verticalSlope:bestVertical.slope}};

  const left=verticalGrid.x[0],right=verticalGrid.x[4];
  let bestHorizontal=null;
  for(let slope=-.22;slope<=.2201;slope+=.01){
    const projection=horizontalProjection(points,width,height,slope,left,right,bestVertical.slope);
    const peaks=findPeaks(projection,height*.04,height*.99,Math.max(4,height*.005));
    const score=scoreTop(peaks,44);
    if(!bestHorizontal||score>bestHorizontal.score)bestHorizontal={score,slope,projection,peaks};
  }
  const horizontalGrid=selectHorizontalGrid(bestHorizontal.peaks,height);
  if(!horizontalGrid)return {points:fallbackQuad(width,height),confidence:.12,debug:{reason:'没有找到连续31行',verticalSlope:bestVertical.slope,verticalLines:verticalGrid.x}};

  const midX=(left+right)/2,midY=height/2,top=horizontalGrid.start,bottom=horizontalGrid.bottom;
  const quad=[
    lineIntersection(top,bestHorizontal.slope,left,bestVertical.slope,midX,midY),
    lineIntersection(top,bestHorizontal.slope,right,bestVertical.slope,midX,midY),
    lineIntersection(bottom,bestHorizontal.slope,right,bestVertical.slope,midX,midY),
    lineIntersection(bottom,bestHorizontal.slope,left,bestVertical.slope,midX,midY)
  ].map(p=>({x:clamp(p.x,0,width-1),y:clamp(p.y,0,height-1)}));

  const rowConfidence=horizontalGrid.matches/32;
  const lineStrength=clamp(verticalGrid.group.reduce((s,p)=>s+p.strength,0)/(height*1.2),0,1);
  const confidence=clamp(rowConfidence*.75+lineStrength*.25,0,1);
  return {points:quad,confidence,debug:{reason:'ok',rowMatches:horizontalGrid.matches,rowStep:horizontalGrid.step,horizontalSlope:bestHorizontal.slope,verticalSlope:bestVertical.slope,verticalLines:verticalGrid.x}};
}

export function detectTargetGrid(imageData){
  return detectTargetGridFromGray(grayFromImageData(imageData),imageData.width,imageData.height);
}

export function quadPoint(quad,u,v){
  const top={x:quad[0].x+(quad[1].x-quad[0].x)*u,y:quad[0].y+(quad[1].y-quad[0].y)*u};
  const bottom={x:quad[3].x+(quad[2].x-quad[3].x)*u,y:quad[3].y+(quad[2].y-quad[3].y)*u};
  return {x:top.x+(bottom.x-top.x)*v,y:top.y+(bottom.y-top.y)*v};
}
