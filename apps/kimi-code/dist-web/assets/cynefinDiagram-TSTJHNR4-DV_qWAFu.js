import{p as xt}from"./chunk-JWPE2WC7-CPYc1Q95.js";import{s as gt,g as $t,p as bt,o as wt,a as Ct,b as vt,_ as s,l as O,F as Dt,e as kt,q as Tt,B as U,z as Q,D as At,W as ot}from"./mermaid.core-DHQD1STq.js";import{p as Bt}from"./cynefin-VYW2F7L2-Cbq_W2rg.js";import"./index-CgXirkUy.js";import"./_commonjsHelpers-CqkleIqs.js";var rt=s(()=>({domains:new Map,transitions:[]}),"createDefaultData"),H=rt(),St=s(()=>H.domains,"getDomains"),Mt=s(()=>H.transitions,"getTransitions"),zt=s(t=>{if(t)for(const e of t){const n=e.domain,a=(e.items??[]).map(c=>({label:c.label}));H.domains.set(n,{name:n,items:a})}},"setDomains"),Lt=s(t=>{t&&(H.transitions=t.filter(e=>e.from===e.to?(O.warn(`Cynefin: self-loop transition on domain "${e.from}" is not meaningful and will be skipped.`),!1):!0).map(e=>({from:e.from,to:e.to,label:e.label||void 0})))},"setTransitions"),Nt=s(()=>U({...At.cynefin,...Q().cynefin}),"getConfig"),Pt=s(()=>{Tt(),H=rt()},"clear"),Y={getDomains:St,getTransitions:Mt,setDomains:zt,setTransitions:Lt,getConfig:Nt,clear:Pt,setAccTitle:vt,getAccTitle:Ct,setDiagramTitle:wt,getDiagramTitle:bt,getAccDescription:$t,setAccDescription:gt},Wt=s(t=>{xt(t,Y),Y.setDomains(t.domains),Y.setTransitions(t.transitions)},"populate"),It={parse:s(async t=>{const e=await Bt("cynefin",t);O.debug(e),Wt(e)},"parse")};function E(t){let e=t+1831565813|0;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}s(E,"seededRandom");function st(t){let e=0;for(let n=0;n<t.length;n++){const a=t.charCodeAt(n);e=(e<<5)-e+a,e|=0}return e}s(st,"hashString");function it(t,e){return typeof t=="number"&&Number.isFinite(t)&&t!==0?t:st(e)}s(it,"resolveSeed");function ct(t,e,n,a){const c=t/2,m=a??t*.015,v=7,I=e/v,d=[];for(let o=0;o<=v;o++){const p=E(n+o*17)*m*2-m;d.push({x:c+p,y:o*I})}let D=`M${d[0].x},${d[0].y}`;for(let o=0;o<d.length-1;o++){const p=d[o],i=d[o+1],f=(p.y+i.y)/2,b=o%2===0?1:-1,h=m*1.5*b*E(n+o*31+7),F=p.x+h,R=f,_=i.x-h;D+=` C${F},${R} ${_},${f} ${i.x},${i.y}`}return D}s(ct,"generateFoldPath");function lt(t,e,n,a){const c=e/2,m=a??e*.015,v=7,I=t/v,d=[];for(let o=0;o<=v;o++){const p=E(n+o*23)*m*2-m;d.push({x:o*I,y:c+p})}let D=`M${d[0].x},${d[0].y}`;for(let o=0;o<d.length-1;o++){const p=d[o],i=d[o+1],f=(p.x+i.x)/2,b=o%2===0?1:-1,h=m*1.5*b*E(n+o*37+11),F=f,R=p.y+h,_=f,z=i.y-h;D+=` C${F},${R} ${_},${z} ${i.x},${i.y}`}return D}s(lt,"generateHorizontalBoundary");function dt(t,e){const n=t/2,a=e*.5,c=e,m=t*.03;return[`M${n},${a}`,`C${n+m},${a+(c-a)*.2}`,`${n-m*1.5},${a+(c-a)*.55}`,`${n+m*.5},${a+(c-a)*.75}`,`C${n-m},${a+(c-a)*.85}`,`${n+m*.3},${a+(c-a)*.95}`,`${n},${c}`].join(" ")}s(dt,"generateCliffPath");function ft(t,e,n,a){return[`M${t-n},${e}`,`A${n},${a} 0 1,1 ${t+n},${e}`,`A${n},${a} 0 1,1 ${t-n},${e}`,"Z"].join(" ")}s(ft,"generateConfusionPath");var at={complex:{model:"Probe → Sense → Respond",practice:"Emergent Practices"},complicated:{model:"Sense → Analyse → Respond",practice:"Good Practices"},clear:{model:"Sense → Categorise → Respond",practice:"Best Practices"},chaotic:{model:"Act → Sense → Respond",practice:"Novel Practices"},confusion:{model:"",practice:"Disorder"}},Ft=s((t,e)=>{const n=t/2,a=e/2;return{complex:{cx:n/2,cy:a/2,x:0,y:0,w:n,h:a},complicated:{cx:n+n/2,cy:a/2,x:n,y:0,w:n,h:a},chaotic:{cx:n/2,cy:a+a/2,x:0,y:a,w:n,h:a},clear:{cx:n+n/2,cy:a+a/2,x:n,y:a,w:n,h:a},confusion:{cx:n,cy:a,x:n*.7,y:a*.7,w:n*.6,h:a*.6}}},"getDomainLayouts"),Rt=s(()=>{const t=ot(),e=Q();return U(t,e.themeVariables).cynefin},"getCynefinDomainColors"),q=3,_t=s((t,e,n,a)=>{const c=a.db,m=c.getDomains(),v=c.getTransitions(),I=c.getDiagramTitle(),d=c.getAccTitle(),D=c.getAccDescription(),o=c.getConfig(),p=Rt();O.debug("Rendering Cynefin diagram");const i=o.width,f=o.height,b=o.padding,h=o.showDomainDescriptions,F=o.boundaryAmplitude,R=i+b*2,_=f+b*2,z={complex:p.complexBg,complicated:p.complicatedBg,clear:p.clearBg,chaotic:p.chaoticBg,confusion:p.confusionBg},k=Dt(e);kt(k,_,R,o.useMaxWidth??!0),k.attr("viewBox",`0 0 ${R} ${_}`),d&&k.append("title").text(d),D&&k.append("desc").text(D);const T=k.append("g").attr("transform",`translate(${b}, ${b})`),V=Ft(i,f),Z=it(o.seed,e),mt=T.append("g").attr("class","cynefin-backgrounds"),X=["complex","complicated","chaotic","clear"];for(const l of X){const r=V[l];mt.append("rect").attr("class","cynefinDomain").attr("x",r.x).attr("y",r.y).attr("width",r.w).attr("height",r.h).attr("fill",z[l]).attr("fill-opacity",.4).attr("stroke","none")}const j=T.append("g").attr("class","cynefin-boundaries");j.append("path").attr("class","cynefinBoundary").attr("d",ct(i,f,Z,F)).attr("fill","none"),j.append("path").attr("class","cynefinBoundary").attr("d",lt(i,f,Z+100,F)).attr("fill","none"),j.append("path").attr("class","cynefinCliff").attr("d",dt(i,f)).attr("fill","none");const pt=i*.15,yt=f*.15;T.append("path").attr("class","cynefinConfusion").attr("d",ft(i/2,f/2,pt,yt)).attr("fill",z.confusion).attr("fill-opacity",.5);const J=T.append("g").attr("class","cynefin-labels");for(const l of X){const r=V[l];J.append("text").attr("class","cynefinDomainLabel").attr("x",r.cx).attr("y",h?r.cy-30:r.cy).attr("text-anchor","middle").attr("dominant-baseline","middle").text(l.charAt(0).toUpperCase()+l.slice(1))}if(J.append("text").attr("class","cynefinDomainLabel").attr("x",i/2).attr("y",h?f/2-10:f/2).attr("text-anchor","middle").attr("dominant-baseline","middle").text("Confusion"),h){const l=T.append("g").attr("class","cynefin-subtitles");for(const r of X){const u=V[r],y=at[r];l.append("text").attr("class","cynefinSubtitle").attr("x",u.cx).attr("y",u.cy-10).attr("text-anchor","middle").attr("dominant-baseline","middle").text(y.model),l.append("text").attr("class","cynefinSubtitle").attr("x",u.cx).attr("y",u.cy+5).attr("text-anchor","middle").attr("dominant-baseline","middle").text(y.practice)}l.append("text").attr("class","cynefinSubtitle").attr("x",i/2).attr("y",f/2+8).attr("text-anchor","middle").attr("dominant-baseline","middle").text(at.confusion.practice)}const K=T.append("g").attr("class","cynefin-items"),A=26,tt=10,ut=["complex","complicated","chaotic","clear","confusion"];for(const l of ut){const r=m.get(l);if(!r||r.items.length===0)continue;const u=V[l],y=l==="confusion";let L=r.items,N=0;y&&r.items.length>q&&(N=r.items.length-q,L=r.items.slice(0,q));let B;if(y){const g=h?22:14;B=u.cy+g}else B=u.cy+(h?25:15);if([...L].forEach((g,S)=>{const w=B+S*(A+4),M=K.append("g"),P=M.append("text").attr("class","cynefinItemText").attr("x",0).attr("y",A/2).attr("text-anchor","middle").attr("dominant-baseline","central").text(g.label);let $=g.label.length*7;const x=P.node();if(x&&typeof x.getBBox=="function"){const G=x.getBBox();G.width>0&&($=G.width)}const C=$+tt*2,W=u.cx-C/2;M.attr("transform",`translate(${W}, ${w})`),M.insert("rect","text").attr("class","cynefinItem").attr("x",0).attr("y",0).attr("width",C).attr("height",A).attr("rx",4).attr("ry",4).attr("fill",z[l]).attr("fill-opacity",.95),P.attr("x",C/2).attr("y",A/2)}),N>0){const g=B+L.length*(A+4),S=`+${N} more`,w=K.append("g"),M=w.append("text").attr("class","cynefinItemText").attr("x",0).attr("y",A/2).attr("text-anchor","middle").attr("dominant-baseline","central").text(S);let P=S.length*7;const $=M.node();if($&&typeof $.getBBox=="function"){const W=$.getBBox();W.width>0&&(P=W.width)}const x=P+tt*2,C=u.cx-x/2;w.attr("transform",`translate(${C}, ${g})`),w.insert("rect","text").attr("class","cynefinItemOverflow").attr("x",0).attr("y",0).attr("width",x).attr("height",A).attr("rx",4).attr("ry",4).attr("fill",z[l]).attr("fill-opacity",.6),M.attr("x",x/2).attr("y",A/2)}}if(v.length>0){const l=k.select("defs").empty()?k.append("defs"):k.select("defs"),r=`cynefin-arrow-${e}`;l.append("marker").attr("id",r).attr("viewBox","0 0 10 10").attr("refX",9).attr("refY",5).attr("markerWidth",6).attr("markerHeight",6).attr("orient","auto-start-reverse").append("path").attr("d","M 0 0 L 10 5 L 0 10 z").attr("class","cynefinArrowHead");const u=T.append("g").attr("class","cynefin-arrows");v.forEach(y=>{const L=V[y.from],N=V[y.to];if(!L||!N)return;if(y.from===y.to){O.warn(`Cynefin renderer: skipping self-loop on domain "${y.from}"`);return}const B=L.cx,g=L.cy,S=N.cx,w=N.cy,M=(B+S)/2,P=(g+w)/2,$=S-B,x=w-g,C=Math.sqrt($*$+x*x),W=C*.15,G=-x/C,ht=$/C,et=M+G*W,nt=P+ht*W;u.append("path").attr("class","cynefinArrowLine").attr("d",`M${B},${g} Q${et},${nt} ${S},${w}`).attr("fill","none").attr("marker-end",`url(#${r})`),y.label&&u.append("text").attr("class","cynefinArrowLabel").attr("x",et).attr("y",nt-6).attr("text-anchor","middle").attr("dominant-baseline","auto").text(y.label)})}I&&T.append("text").attr("class","cynefinTitle").attr("x",i/2).attr("y",-b/2).attr("text-anchor","middle").attr("dominant-baseline","middle").text(I)},"draw"),Vt={draw:_t},Et=s(()=>{const t=ot(),e=Q();return U(t,e.themeVariables).cynefin},"getCynefinTheme"),Ht=s(()=>{const t=Et();return`
	.cynefinDomain {
		stroke: none;
	}
	.cynefinDomainLabel {
		font-size: ${t.domainFontSize}px;
		font-weight: bold;
		fill: ${t.labelColor};
	}
	.cynefinSubtitle {
		font-size: ${t.itemFontSize-1}px;
		fill: ${t.textColor};
		font-style: italic;
	}
	.cynefinItem {
		fill-opacity: 0.95;
		stroke: ${t.boundaryColor};
		stroke-width: 1;
	}
	.cynefinItemText {
		font-size: ${t.itemFontSize}px;
		fill: ${t.textColor};
	}
	.cynefinItemOverflow {
		fill-opacity: 0.6;
		stroke: ${t.boundaryColor};
		stroke-width: 1;
		stroke-dasharray: 3 2;
	}
	.cynefinBoundary {
		stroke: ${t.boundaryColor};
		stroke-width: ${t.boundaryWidth};
		stroke-dasharray: 6 3;
	}
	.cynefinCliff {
		stroke: ${t.cliffColor};
		stroke-width: ${t.cliffWidth};
	}
	.cynefinConfusion {
		stroke: ${t.boundaryColor};
		stroke-width: 1.5;
		stroke-dasharray: 4 2;
	}
	.cynefinArrowLine {
		stroke: ${t.arrowColor};
		stroke-width: ${t.arrowWidth};
		fill: none;
	}
	.cynefinArrowHead {
		fill: ${t.arrowColor};
		stroke: none;
	}
	.cynefinArrowLabel {
		font-size: ${t.itemFontSize-1}px;
		fill: ${t.textColor};
	}
	.cynefinTitle {
		font-size: ${t.domainFontSize+2}px;
		font-weight: bold;
		fill: ${t.labelColor};
	}
	`},"styles"),Gt=Ht,Ut={parser:It,db:Y,renderer:Vt,styles:Gt};export{Ut as diagram};
