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
  const s=validateScene(value);
  const archive = pptxArchive(s);
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

/**
 * Build the small OOXML package needed by a single-slide native diagram.
 * Keeping this writer local avoids pulling an image parser into the server:
 * diagrams contain only DrawingML text, geometry and connectors.
 */
function pptxArchive(s: DiagramScene): Record<string, Uint8Array> {
  const esc = xml;
  const emu = (px: number) => Math.round(px * 9144);
  const shapeType = (shape: DiagramNode["shape"]) => shape === "roundRect" ? "roundRect" : shape === "ellipse" ? "ellipse" : shape === "diamond" ? "diamond" : "rect";
  const shape = (node: DiagramNode, index: number) => `<p:sp><p:nvSpPr><p:cNvPr id="${index}" name="${esc(node.id)}"/><p:cNvSpPr txBox="0"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(node.x)}" y="${emu(node.y)}"/><a:ext cx="${emu(node.width)}" cy="${emu(node.height)}"/></a:xfrm><a:prstGeom prst="${shapeType(node.shape)}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${node.fill.slice(1)}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="557869"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${node.label.split("\\n").map((line, i) => `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="1400"><a:solidFill><a:srgbClr val="${node.color.slice(1)}"/></a:solidFill></a:rPr><a:t>${esc(line)}</a:t></a:r>${i < node.label.split("\\n").length - 1 ? "<a:br/>" : ""}</a:p>`).join("")}</p:txBody></p:sp>`;
  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${s.nodes.map((node, i) => shape(node, i + 2)).join("")}${s.edges.map((edge, i) => { const p = endpoints(s.nodes.find(n => n.id === edge.from)!, s.nodes.find(n => n.id === edge.to)!); const from = s.nodes.findIndex(n => n.id === edge.from) + 2; const to = s.nodes.findIndex(n => n.id === edge.to) + 2; const horizontal = p.y1 === s.nodes.find(n => n.id === edge.from)!.y + s.nodes.find(n => n.id === edge.from)!.height / 2; const start = horizontal ? (p.x2 >= p.x1 ? 3 : 1) : (p.y2 >= p.y1 ? 2 : 0); const end = horizontal ? (p.x2 >= p.x1 ? 1 : 3) : (p.y2 >= p.y1 ? 0 : 2); return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${s.nodes.length + i + 2}" name="${esc(edge.id)}"/><p:cNvCxnSpPr><a:stCxn id="${from}" idx="${start}"/><a:endCxn id="${to}" idx="${end}"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="557869"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>`; }).join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
  const content = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/></Types>`;
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="${emu(s.width)}" cy="${emu(s.height)}" type="custom"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  const layout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const master = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Master"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/></p:sldMaster>`;
  const bytes = (text: string) => strToU8(text);
  return { "[Content_Types].xml": bytes(content), "_rels/.rels": bytes(rootRels), "ppt/presentation.xml": bytes(presentation), "ppt/_rels/presentation.xml.rels": bytes(rels.replace("../slideLayouts/slideLayout1.xml", "slides/slide1.xml")), "ppt/slides/slide1.xml": bytes(slide), "ppt/slideLayouts/slideLayout1.xml": bytes(layout), "ppt/slideMasters/slideMaster1.xml": bytes(master) };
}
