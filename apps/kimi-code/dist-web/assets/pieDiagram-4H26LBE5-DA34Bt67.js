import{Y as S,a1 as R,b2 as J,g as K,s as Q,a as tt,b as et,q as at,p as rt,_ as p,l as z,c as nt,F as it,I as st,N as ot,e as lt,z as ct,G as ut}from"./mermaid.core-zKrc8Ye9.js";import{p as pt}from"./chunk-4BX2VUAB-Bjjry6OZ.js";import{p as dt}from"./wardley-L42UT6IY-gSV1j6uw.js";import{d as P}from"./arc-DtCnpCZe.js";import{o as gt}from"./ordinal-Cboi1Yqb.js";import"./index-DtRfJ0vw.js";import"./init-Gi6I4Gst.js";function ft(t,a){return a<t?-1:a>t?1:a>=t?0:NaN}function ht(t){return t}function mt(){var t=ht,a=ft,f=null,y=S(0),s=S(R),d=S(0);function o(e){var n,l=(e=J(e)).length,g,h,v=0,c=new Array(l),i=new Array(l),x=+y.apply(this,arguments),w=Math.min(R,Math.max(-R,s.apply(this,arguments)-x)),m,D=Math.min(Math.abs(w)/l,d.apply(this,arguments)),$=D*(w<0?-1:1),u;for(n=0;n<l;++n)(u=i[c[n]=n]=+t(e[n],n,e))>0&&(v+=u);for(a!=null?c.sort(function(A,C){return a(i[A],i[C])}):f!=null&&c.sort(function(A,C){return f(e[A],e[C])}),n=0,h=v?(w-l*$)/v:0;n<l;++n,x=m)g=c[n],u=i[g],m=x+(u>0?u*h:0)+$,i[g]={data:e[g],index:n,value:u,startAngle:x,endAngle:m,padAngle:D};return i}return o.value=function(e){return arguments.length?(t=typeof e=="function"?e:S(+e),o):t},o.sortValues=function(e){return arguments.length?(a=e,f=null,o):a},o.sort=function(e){return arguments.length?(f=e,a=null,o):f},o.startAngle=function(e){return arguments.length?(y=typeof e=="function"?e:S(+e),o):y},o.endAngle=function(e){return arguments.length?(s=typeof e=="function"?e:S(+e),o):s},o.padAngle=function(e){return arguments.length?(d=typeof e=="function"?e:S(+e),o):d},o}var vt=ut.pie,F={sections:new Map,showData:!1},T=F.sections,W=F.showData,xt=structuredClone(vt),St=p(()=>structuredClone(xt),"getConfig"),yt=p(()=>{T=new Map,W=F.showData,ct()},"clear"),wt=p(({label:t,value:a})=>{if(a<0)throw new Error(`"${t}" has invalid value: ${a}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);T.has(t)||(T.set(t,a),z.debug(`added new section: ${t}, with value: ${a}`))},"addSection"),At=p(()=>T,"getSections"),Ct=p(t=>{W=t},"setShowData"),Dt=p(()=>W,"getShowData"),_={getConfig:St,clear:yt,setDiagramTitle:rt,getDiagramTitle:at,setAccTitle:et,getAccTitle:tt,setAccDescription:Q,getAccDescription:K,addSection:wt,getSections:At,setShowData:Ct,getShowData:Dt},$t=p((t,a)=>{pt(t,a),a.setShowData(t.showData),t.sections.map(a.addSection)},"populateDb"),Tt={parse:p(async t=>{const a=await dt("pie",t);z.debug(a),$t(a,_)},"parse")},bt=p(t=>`
  .pieCircle{
    stroke: ${t.pieStrokeColor};
    stroke-width : ${t.pieStrokeWidth};
    opacity : ${t.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${t.pieOuterStrokeColor};
    stroke-width: ${t.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${t.pieTitleTextSize};
    fill: ${t.pieTitleTextColor};
    font-family: ${t.fontFamily};
  }
  .slice {
    font-family: ${t.fontFamily};
    fill: ${t.pieSectionTextColor};
    font-size:${t.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${t.pieLegendTextColor};
    font-family: ${t.fontFamily};
    font-size: ${t.pieLegendTextSize};
  }
`,"getStyles"),kt=bt,Et=p(t=>{const a=[...t.values()].reduce((s,d)=>s+d,0),f=[...t.entries()].map(([s,d])=>({label:s,value:d})).filter(s=>s.value/a*100>=1);return mt().value(s=>s.value).sort(null)(f)},"createPieArcs"),Mt=p((t,a,f,y)=>{z.debug(`rendering pie chart
`+t);const s=y.db,d=nt(),o=it(s.getConfig(),d.pie),e=40,n=18,l=4,g=450,h=g,v=st(a),c=v.append("g");c.attr("transform","translate("+h/2+","+g/2+")");const{themeVariables:i}=d;let[x]=ot(i.pieOuterStrokeWidth);x??=2;const w=o.textPosition,m=Math.min(h,g)/2-e,D=P().innerRadius(0).outerRadius(m),$=P().innerRadius(m*w).outerRadius(m*w);c.append("circle").attr("cx",0).attr("cy",0).attr("r",m+x/2).attr("class","pieOuterCircle");const u=s.getSections(),A=Et(u),C=[i.pie1,i.pie2,i.pie3,i.pie4,i.pie5,i.pie6,i.pie7,i.pie8,i.pie9,i.pie10,i.pie11,i.pie12];let b=0;u.forEach(r=>{b+=r});const G=A.filter(r=>(r.data.value/b*100).toFixed(0)!=="0"),k=gt(C).domain([...u.keys()]);c.selectAll("mySlices").data(G).enter().append("path").attr("d",D).attr("fill",r=>k(r.data.label)).attr("class","pieCircle"),c.selectAll("mySlices").data(G).enter().append("text").text(r=>(r.data.value/b*100).toFixed(0)+"%").attr("transform",r=>"translate("+$.centroid(r)+")").style("text-anchor","middle").attr("class","slice");const V=c.append("text").text(s.getDiagramTitle()).attr("x",0).attr("y",-400/2).attr("class","pieTitleText"),N=[...u.entries()].map(([r,M])=>({label:r,value:M})),E=c.selectAll(".legend").data(N).enter().append("g").attr("class","legend").attr("transform",(r,M)=>{const O=n+l,Y=O*N.length/2,Z=12*n,H=M*O-Y;return"translate("+Z+","+H+")"});E.append("rect").attr("width",n).attr("height",n).style("fill",r=>k(r.label)).style("stroke",r=>k(r.label)),E.append("text").attr("x",n+l).attr("y",n-l).text(r=>s.getShowData()?`${r.label} [${r.value}]`:r.label);const U=Math.max(...E.selectAll("text").nodes().map(r=>r?.getBoundingClientRect().width??0)),j=h+e+n+l+U,L=V.node()?.getBoundingClientRect().width??0,q=h/2-L/2,X=h/2+L/2,B=Math.min(0,q),I=Math.max(j,X)-B;v.attr("viewBox",`${B} 0 ${I} ${g}`),lt(v,g,I,o.useMaxWidth)},"draw"),Rt={draw:Mt},Ot={parser:Tt,db:_,renderer:Rt,styles:kt};export{Ot as diagram};
