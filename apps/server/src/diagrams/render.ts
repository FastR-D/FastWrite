import PptxGenJS from "pptxgenjs";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { validateScene, type DiagramScene, type DiagramNode } from "./scene";

const xml = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!));
function endpoints(a: DiagramNode, b: DiagramNode) {
  const ax=a.x+a.width/2, ay=a.y+a.height/2, bx=b.x+b.width/2, by=b.y+b.height/2;
  const horizontal=Math.abs(bx-ax)/Math.max(1,(a.width+b.width)/2)>=Math.abs(by-ay)/Math.max(1,(a.height+b.height)/2);
  return horizontal ? { x1: ax+(bx>=ax?1:-1)*a.width/2,y1:ay,x2:bx-(bx>=ax?1:-1)*b.width/2,y2:by } : {x1:ax,y1:ay+(by>=ay?1:-1)*a.height/2,x2:bx,y2:by-(by>=ay?1:-1)*b.height/2};
}
export function renderDrawio(value: DiagramScene): string {
  const scene=validateScene(value);
  const nodes=scene.nodes.map(n=>`<mxCell id="${xml(n.id)}" value="${xml(n.label)}" style="${n.shape==='ellipse'?'ellipse;':n.shape==='diamond'?'rhombus;':n.shape==='roundRect'?'rounded=1;':'rounded=0;'}whiteSpace=wrap;html=0;fillColor=${n.fill};fontColor=${n.color};strokeColor=#557869;fontSize=18;" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" as="geometry"/></mxCell>`).join('');
  const edges=scene.edges.map(e=>`<mxCell id="${xml(e.id)}" value="${xml(e.label)}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;endArrow=block;strokeColor=#557869;fontSize=14;" edge="1" parent="1" source="${xml(e.from)}" target="${xml(e.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><mxfile host="FastWrite" version="1"><diagram id="diagram" name="${xml(scene.title)}"><mxGraphModel page="1" pageWidth="${scene.width}" pageHeight="${scene.height}"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${edges}${nodes}</root></mxGraphModel></diagram></mxfile>`;
}
export function renderSvg(value: DiagramScene): string {
  const s=validateScene(value);
  const edges=s.edges.map(e=>{const p=endpoints(s.nodes.find(n=>n.id===e.from)!,s.nodes.find(n=>n.id===e.to)!);return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="#557869" stroke-width="2" marker-end="url(#arrow)"/><text x="${(p.x1+p.x2)/2}" y="${(p.y1+p.y2)/2-8}" text-anchor="middle" font-size="14">${xml(e.label)}</text>`}).join('');
  const nodes=s.nodes.map(n=>{let shape=n.shape==='ellipse'?`<ellipse cx="${n.x+n.width/2}" cy="${n.y+n.height/2}" rx="${n.width/2}" ry="${n.height/2}"`:n.shape==='diamond'?`<polygon points="${n.x+n.width/2},${n.y} ${n.x+n.width},${n.y+n.height/2} ${n.x+n.width/2},${n.y+n.height} ${n.x},${n.y+n.height/2}"`:`<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="${n.shape==='roundRect'?12:0}"`;const lines=n.label.split('\n');return shape+` fill="${n.fill}" stroke="#557869" stroke-width="2"/><text fill="${n.color}" font-size="18" text-anchor="middle">${lines.map((line,i)=>`<tspan x="${n.x+n.width/2}" y="${n.y+n.height/2+(i-(lines.length-1)/2)*24+6}">${xml(line)}</tspan>`).join('')}</text>`}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}" viewBox="0 0 ${s.width} ${s.height}" role="img"><title>${xml(s.title)}</title><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#557869"/></marker></defs><rect width="100%" height="100%" fill="#ffffff"/><g font-family="Arial,Microsoft YaHei,sans-serif" fill="#304c3c">${edges}${nodes}</g></svg>`;
}
export async function renderPptx(value: DiagramScene): Promise<Uint8Array> {
  const s=validateScene(value);const pptx=new PptxGenJS();const scale=100;
  pptx.defineLayout({name:'DIAGRAM',width:s.width/scale,height:s.height/scale});pptx.layout='DIAGRAM';pptx.author='FastWrite';pptx.subject='Editable native scientific diagram';pptx.title=s.title;
  const slide=pptx.addSlide();slide.background={color:'FFFFFF'};
  for(const e of s.edges){const p=endpoints(s.nodes.find(n=>n.id===e.from)!,s.nodes.find(n=>n.id===e.to)!);slide.addShape(pptx.ShapeType.line,{x:Math.min(p.x1,p.x2)/scale,y:Math.min(p.y1,p.y2)/scale,w:Math.abs(p.x2-p.x1)/scale,h:Math.abs(p.y2-p.y1)/scale,flipH:p.x2<p.x1,flipV:p.y2<p.y1,line:{color:'557869',width:1.5,beginArrowType:'none',endArrowType:'triangle'},objectName:e.id});if(e.label)slide.addText(e.label,{x:(p.x1+p.x2)/2/scale-.65,y:(p.y1+p.y2)/2/scale-.25,w:1.3,h:.25,fontSize:10,align:'center',color:'557869',margin:0});}
  for(const n of s.nodes){slide.addText(n.label,{shape:pptx.ShapeType[n.shape],x:n.x/scale,y:n.y/scale,w:n.width/scale,h:n.height/scale,fill:{color:n.fill.slice(1)},line:{color:'557869',width:1.4},color:n.color.slice(1),fontFace:'Microsoft YaHei',fontSize:14,breakLine:false,align:'center',valign:'middle',margin:8,fit:'shrink',objectName:n.id});}
  const archive=unzipSync(new Uint8Array(await pptx.write({outputType:'arraybuffer'}) as ArrayBuffer));
  let slideXml=strFromU8(archive['ppt/slides/slide1.xml']!);
  const shapeIds=new Map<string,string>();
  for(const match of slideXml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"[^>]*\bname="([^"]+)"/g))shapeIds.set(match[2]!,match[1]!);
  // PptxGenJS emits lines as generic shapes. Promote them to real DrawingML
  // connectors and attach their endpoints to the native node shape IDs.
  slideXml=slideXml.replace(/<p:sp>.*?<\/p:sp>/gs,block=>{
    const name=/<p:cNvPr\b[^>]*\bname="([^"]+)"/.exec(block)?.[1];
    const edge=s.edges.find(e=>e.id===name);if(!edge)return block;
    const from=shapeIds.get(edge.from),to=shapeIds.get(edge.to);if(!from||!to)throw new Error('Native connector target missing');
    const a=s.nodes.find(n=>n.id===edge.from)!,b=s.nodes.find(n=>n.id===edge.to)!,p=endpoints(a,b);
    const horizontal=p.y1===a.y+a.height/2;
    const start=horizontal?(p.x2>=p.x1?3:1):(p.y2>=p.y1?2:0),end=horizontal?(p.x2>=p.x1?1:3):(p.y2>=p.y1?0:2);
    return block.replace('<p:sp>','<p:cxnSp>').replace('</p:sp>','</p:cxnSp>')
      .replace(/p:nvSpPr/g,'p:nvCxnSpPr')
      .replace(/<p:cNvSpPr\b[^>]*(?:\/>|>.*?<\/p:cNvSpPr>)/s,`<p:cNvCxnSpPr><a:stCxn id="${from}" idx="${start}"/><a:endCxn id="${to}" idx="${end}"/></p:cNvCxnSpPr>`)
      .replace(/<p:txBody>.*?<\/p:txBody>/s,'');
  });
  archive['ppt/slides/slide1.xml']=strToU8(slideXml);
  return zipSync(archive,{level:6});
}
