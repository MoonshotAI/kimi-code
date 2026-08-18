import{p as k}from"./chunk-JWPE2WC7-DYhWNXPR.js";import{s as R,g as F,p as I,o as _,a as D,b as E,_ as c,F as z,q as P,B as y,z as C,D as G,l as B,W,e as V}from"./mermaid.core-cXaFT3ek.js";import{p as H}from"./cynefin-VYW2F7L2-BRNWksTk.js";import"./index-BdL5hCoZ.js";import"./_commonjsHelpers-CqkleIqs.js";var m={showLegend:!0,ticks:5,max:null,min:0,graticule:"circle"},w={axes:[],curves:[],options:m},x=structuredClone(w),j=G.radar,q=c(()=>y({...j,...C().radar}),"getConfig"),b=c(()=>x.axes,"getAxes"),N=c(()=>x.curves,"getCurves"),U=c(()=>x.options,"getOptions"),X=c(a=>{x.axes=a.map(t=>({name:t.name,label:t.label??t.name}))},"setAxes"),Y=c(a=>{x.curves=a.map(t=>({name:t.name,label:t.label??t.name,entries:Z(t.entries)}))},"setCurves"),Z=c(a=>{if(a[0].axis==null)return a.map(e=>e.value);const t=b();if(t.length===0)throw new Error("Axes must be populated before curves for reference entries");return t.map(e=>{const r=a.find(s=>s.axis?.$refText===e.name);if(r===void 0)throw new Error("Missing entry for axis "+e.label);return r.value})},"computeCurveEntries"),J=c(a=>{const t=a.reduce((e,r)=>(e[r.name]=r,e),{});x.options={showLegend:t.showLegend?.value??m.showLegend,ticks:t.ticks?.value??m.ticks,max:t.max?.value??m.max,min:t.min?.value??m.min,graticule:t.graticule?.value??m.graticule}},"setOptions"),K=c(()=>{P(),x=structuredClone(w)},"clear"),$={getAxes:b,getCurves:N,getOptions:U,setAxes:X,setCurves:Y,setOptions:J,getConfig:q,clear:K,setAccTitle:E,getAccTitle:D,setDiagramTitle:_,getDiagramTitle:I,getAccDescription:F,setAccDescription:R},Q=c(a=>{k(a,$);const{axes:t,curves:e,options:r}=a;$.setAxes(t),$.setCurves(e),$.setOptions(r)},"populate"),tt={parse:c(async a=>{const t=await H("radar",a);B.debug(t),Q(t)},"parse")},et=c((a,t,e,r)=>{const s=r.db,i=s.getAxes(),l=s.getCurves(),n=s.getOptions(),o=s.getConfig(),d=s.getDiagramTitle(),p=z(t),u=at(p,o),g=n.max??Math.max(...l.map(f=>Math.max(...f.entries))),h=n.min,v=Math.min(o.width,o.height)/2;rt(u,i,v,n.ticks,n.graticule),st(u,i,v,o),A(u,i,l,h,g,n.graticule,o),T(u,l,n.showLegend,o),u.append("text").attr("class","radarTitle").text(d).attr("x",0).attr("y",-o.height/2-o.marginTop)},"draw"),at=c((a,t)=>{const e=t.width+t.marginLeft+t.marginRight,r=t.height+t.marginTop+t.marginBottom,s={x:t.marginLeft+t.width/2,y:t.marginTop+t.height/2};return V(a,r,e,t.useMaxWidth??!0),a.attr("viewBox",`0 0 ${e} ${r}`).attr("overflow","visible"),a.append("g").attr("transform",`translate(${s.x}, ${s.y})`)},"drawFrame"),rt=c((a,t,e,r,s)=>{if(s==="circle")for(let i=0;i<r;i++){const l=e*(i+1)/r;a.append("circle").attr("r",l).attr("class","radarGraticule")}else if(s==="polygon"){const i=t.length;for(let l=0;l<r;l++){const n=e*(l+1)/r,o=t.map((d,p)=>{const u=2*p*Math.PI/i-Math.PI/2,g=n*Math.cos(u),h=n*Math.sin(u);return`${g},${h}`}).join(" ");a.append("polygon").attr("points",o).attr("class","radarGraticule")}}},"drawGraticule"),st=c((a,t,e,r)=>{const s=t.length;for(let i=0;i<s;i++){const l=t[i].label,n=2*i*Math.PI/s-Math.PI/2,o=Math.cos(n),d=Math.sin(n);a.append("line").attr("x1",0).attr("y1",0).attr("x2",e*r.axisScaleFactor*o).attr("y2",e*r.axisScaleFactor*d).attr("class","radarAxisLine");const p=o>.01?"start":o<-.01?"end":"middle",u=d>.01?"hanging":d<-.01?"auto":"central",g=4;a.append("text").text(l).attr("x",e*r.axisLabelFactor*o+g*o).attr("y",e*r.axisLabelFactor*d+g*d).attr("text-anchor",p).attr("dominant-baseline",u).attr("class","radarAxisLabel")}},"drawAxes");function A(a,t,e,r,s,i,l){const n=t.length,o=Math.min(l.width,l.height)/2;e.forEach((d,p)=>{if(d.entries.length!==n)return;const u=d.entries.map((g,h)=>{const v=2*Math.PI*h/n-Math.PI/2,f=M(g,r,s,o),S=f*Math.cos(v),O=f*Math.sin(v);return{x:S,y:O}});i==="circle"?a.append("path").attr("d",L(u,l.curveTension)).attr("class",`radarCurve-${p}`):i==="polygon"&&a.append("polygon").attr("points",u.map(g=>`${g.x},${g.y}`).join(" ")).attr("class",`radarCurve-${p}`)})}c(A,"drawCurves");function M(a,t,e,r){const s=Math.min(Math.max(a,t),e);return r*(s-t)/(e-t)}c(M,"relativeRadius");function L(a,t){const e=a.length;let r=`M${a[0].x},${a[0].y}`;for(let s=0;s<e;s++){const i=a[(s-1+e)%e],l=a[s],n=a[(s+1)%e],o=a[(s+2)%e],d={x:l.x+(n.x-i.x)*t,y:l.y+(n.y-i.y)*t},p={x:n.x-(o.x-l.x)*t,y:n.y-(o.y-l.y)*t};r+=` C${d.x},${d.y} ${p.x},${p.y} ${n.x},${n.y}`}return`${r} Z`}c(L,"closedRoundCurve");function T(a,t,e,r){if(!e)return;const s=(r.width/2+r.marginRight)*3/4,i=-(r.height/2+r.marginTop)*3/4,l=20;t.forEach((n,o)=>{const d=a.append("g").attr("transform",`translate(${s}, ${i+o*l})`);d.append("rect").attr("width",12).attr("height",12).attr("class",`radarLegendBox-${o}`),d.append("text").attr("x",16).attr("y",0).attr("class","radarLegendText").text(n.label)})}c(T,"drawLegend");var nt={draw:et},ot=c((a,t)=>{let e="";for(let r=0;r<a.THEME_COLOR_LIMIT;r++){const s=a[`cScale${r}`];e+=`
		.radarCurve-${r} {
			color: ${s};
			fill: ${s};
			fill-opacity: ${t.curveOpacity};
			stroke: ${s};
			stroke-width: ${t.curveStrokeWidth};
		}
		.radarLegendBox-${r} {
			fill: ${s};
			fill-opacity: ${t.curveOpacity};
			stroke: ${s};
		}
		`}return e},"genIndexStyles"),it=c(a=>{const t=W(),e=C(),r=y(t,e.themeVariables),s=y(r.radar,a);return{themeVariables:r,radarOptions:s}},"buildRadarStyleOptions"),lt=c(({radar:a}={})=>{const{themeVariables:t,radarOptions:e}=it(a);return`
	.radarTitle {
		font-size: ${t.fontSize};
		color: ${t.titleColor};
		dominant-baseline: hanging;
		text-anchor: middle;
	}
	.radarAxisLine {
		stroke: ${e.axisColor};
		stroke-width: ${e.axisStrokeWidth};
	}
	.radarAxisLabel {
		font-size: ${e.axisLabelFontSize}px;
		color: ${e.axisColor};
	}
	.radarGraticule {
		fill: ${e.graticuleColor};
		fill-opacity: ${e.graticuleOpacity};
		stroke: ${e.graticuleColor};
		stroke-width: ${e.graticuleStrokeWidth};
	}
	.radarLegendText {
		text-anchor: start;
		font-size: ${e.legendFontSize}px;
		dominant-baseline: hanging;
	}
	${ot(t,e)}
	`},"styles"),xt={parser:tt,db:$,renderer:nt,styles:lt};export{xt as diagram};
