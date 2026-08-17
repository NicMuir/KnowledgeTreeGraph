/**
 * Generate a self-contained HTML force-graph of cross-service links.
 * Usage: kb graph [--out file.html]
 *
 * Nodes = http_call sites, routes, and the functions around them, colored by repo
 * and clustered per repo. Links = cross-service http_calls (bright) + intra calls/contains (faint).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { prisma } from '../packages/db/src';

interface Row { id: string; repo: string; kind: string; name: string; file: string; line: number }
interface EdgeRow { fromId: string; toId: string; kind: string; confidence: number | null }

const NODE_CAP = 550; // keep the force sim smooth; report truncation

async function build(): Promise<{ nodes: Array<Row & { role: string }>; links: Array<{ s: string; t: string; kind: string; cross: boolean; conf: number | null }>; truncated: boolean }> {
  // 1. Cross-service edges are the spine.
  const http = await prisma.$queryRawUnsafe<EdgeRow[]>(
    `SELECT e."fromId", e."toId", e.kind, e.confidence FROM symbol_edges e WHERE e.kind = 'http_calls'`,
  );
  const nodeIds = new Set<string>();
  for (const e of http) { nodeIds.add(e.fromId); nodeIds.add(e.toId); }

  // 2. Grow outward over calls + containment so the function structure is visible,
  //    not just the call-sites. Two hops, capped.
  let frontier = Array.from(nodeIds);
  let truncated = false;
  for (let hop = 0; hop < 2 && nodeIds.size < NODE_CAP; hop++) {
    const rows = await prisma.$queryRawUnsafe<EdgeRow[]>(
      `SELECT e."fromId", e."toId", e.kind, e.confidence FROM symbol_edges e
       WHERE e.kind IN ('contains','calls') AND (e."fromId" = ANY($1) OR e."toId" = ANY($1))`,
      frontier,
    );
    const next: string[] = [];
    for (const e of rows) {
      for (const id of [e.fromId, e.toId]) {
        if (nodeIds.has(id)) continue;
        if (nodeIds.size >= NODE_CAP) { truncated = true; continue; }
        nodeIds.add(id); next.push(id);
      }
    }
    frontier = next;
  }

  // 3. All calls/containment edges among the collected nodes → dense internal structure.
  const ids = Array.from(nodeIds);
  const ctx = await prisma.$queryRawUnsafe<EdgeRow[]>(
    `SELECT e."fromId", e."toId", e.kind, e.confidence FROM symbol_edges e
     WHERE e.kind IN ('contains','calls') AND e."fromId" = ANY($1) AND e."toId" = ANY($1)`,
    ids,
  );

  const links = [
    ...http.map((e) => ({ s: e.fromId, t: e.toId, kind: 'http_calls', cross: true, conf: e.confidence })),
    ...ctx.map((e) => ({ s: e.fromId, t: e.toId, kind: e.kind, cross: false, conf: e.confidence })),
  ];

  // 4. Node metadata.
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT n.id, r.name AS repo, n.kind, n.name, n."filePath" AS file, n."startLine" AS line
     FROM symbol_nodes n JOIN repositories r ON r.id = n."repoId" WHERE n.id = ANY($1)`,
    ids,
  );
  const role = (kind: string) => (kind === 'http_call' ? 'call' : kind === 'route' ? 'route' : 'code');
  const present = new Set(rows.map((r) => r.id));
  return {
    nodes: rows.map((r) => ({ ...r, role: role(r.kind) })),
    links: links.filter((l) => present.has(l.s) && present.has(l.t)),
    truncated,
  };
}

function shortLabel(kind: string, name: string): string {
  if (kind === 'route' || kind === 'http_call') return name; // "GET /api/x"
  return name;
}

async function main(): Promise<void> {
  const outFlag = process.argv.indexOf('--out');
  const out = outFlag !== -1 ? process.argv[outFlag + 1] : path.join(process.cwd(), 'cross-service-map.html');

  const { nodes, links } = await build();
  await prisma.$disconnect();

  const repos = [...new Set(nodes.map((n) => n.repo))].sort();
  const data = {
    nodes: nodes.map((n) => ({ id: n.id, repo: n.repo, role: n.role, label: shortLabel(n.kind, n.name), file: n.file, line: n.line + 1 })),
    links,
    repos,
  };

  const crossPairs = new Set(
    links.filter((l) => l.cross).map((l) => {
      const s = nodes.find((n) => n.id === l.s)?.repo; const t = nodes.find((n) => n.id === l.t)?.repo;
      return `${s} → ${t}`;
    }),
  );

  const html = PAGE
    .replace('/*DATA*/', JSON.stringify(data))
    .replace('__NODES__', String(nodes.length))
    .replace('__LINKS__', String(links.filter((l) => l.cross).length))
    .replace('__PROJECTS__', String(repos.length))
    .replace('__PAIRS__', String(crossPairs.size));

  fs.writeFileSync(out, html);
  console.log(`Wrote ${nodes.length} nodes, ${links.length} links → ${out}`);
  console.log('Cross-service pairs:'); for (const p of crossPairs) console.log('  ' + p);
}

// --- self-contained page (canvas force sim, no deps) ---------------------------
const PAGE = String.raw`<div id="app">
<header>
  <div class="titleblock">
    <h1>Cross-service map</h1>
    <p>HTTP calls resolved to the routes that serve them, across the fleet.</p>
  </div>
  <dl class="stats">
    <div><dt>projects</dt><dd>__PROJECTS__</dd></div>
    <div><dt>cross-service links</dt><dd>__LINKS__</dd></div>
    <div><dt>service pairs</dt><dd>__PAIRS__</dd></div>
    <div><dt>nodes</dt><dd>__NODES__</dd></div>
  </dl>
</header>
<canvas id="c"></canvas>
<aside id="legend"></aside>
<aside id="detail" hidden></aside>
<div id="tip" hidden></div>
<footer>click a node for detail · drag to reposition · hover to trace links</footer>
</div>

<style>
  :root{
    --bg:#0d1117; --panel:#161b22; --line:#21262d; --ink:#e6edf3; --muted:#8b949e;
    --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
  }
  *{box-sizing:border-box}
  #app{position:fixed;inset:0;background:
    radial-gradient(1200px 800px at 70% -10%, #12213040, transparent),
    var(--bg);color:var(--ink);font-family:var(--sans);overflow:hidden}
  canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab}
  canvas:active{cursor:grabbing}
  header{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;
    align-items:flex-start;gap:24px;padding:22px 26px;pointer-events:none;
    background:linear-gradient(#0d1117e0,#0d111700)}
  h1{margin:0;font-size:19px;font-weight:600;letter-spacing:-.01em}
  .titleblock p{margin:3px 0 0;font-size:12.5px;color:var(--muted);max-width:42ch}
  .stats{display:flex;gap:26px;margin:0}
  .stats div{text-align:right}
  .stats dt{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
  .stats dd{margin:2px 0 0;font-family:var(--mono);font-size:22px;font-variant-numeric:tabular-nums;
    font-weight:600}
  #legend{position:absolute;left:26px;bottom:52px;display:flex;flex-direction:column;gap:2px;
    padding:12px 14px;background:var(--panel)cc;backdrop-filter:blur(8px);
    border:1px solid var(--line);border-radius:10px;max-width:340px}
  .lrow{display:grid;grid-template-columns:12px 1fr auto;align-items:center;gap:9px;
    padding:4px 4px;border-radius:6px;cursor:default}
  .lrow:hover{background:#ffffff0a}
  .sw{width:9px;height:9px;border-radius:50%}
  .lname{font-family:var(--mono);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lcount{font-family:var(--mono);font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
  #tip{position:absolute;pointer-events:none;padding:10px 12px;background:#0d1117f7;
    border:1px solid var(--line);border-radius:9px;font-family:var(--mono);font-size:11.5px;
    max-width:340px;line-height:1.4;box-shadow:0 10px 34px #000a;z-index:5}
  #tip b{color:#fff;font-size:12.5px;word-break:break-word}
  #tip .r{display:flex;align-items:center;gap:6px;color:var(--muted);margin:3px 0 2px}
  #tip .sec{margin-top:8px;border-top:1px solid var(--line);padding-top:6px}
  #tip .sec .h{color:#58a6ff;font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
  #tip .more{color:var(--muted);margin-top:2px}
  #detail{position:absolute;top:0;right:0;bottom:0;width:340px;overflow-y:auto;
    padding:20px 18px 24px;background:var(--panel)f2;backdrop-filter:blur(10px);
    border-left:1px solid var(--line);z-index:6;font-size:12px}
  #detail .close{float:right;cursor:pointer;color:var(--muted);font-size:16px;line-height:1;
    padding:2px 6px;border-radius:6px}
  #detail .close:hover{background:#ffffff12;color:var(--ink)}
  #detail .dlabel{font-family:var(--mono);font-size:14px;font-weight:600;color:#fff;
    word-break:break-word;padding-right:24px}
  #detail .dmeta{display:flex;align-items:center;gap:7px;color:var(--muted);
    font-family:var(--mono);margin:7px 0 2px}
  #detail .dloc{font-family:var(--mono);color:var(--muted);font-size:11px;word-break:break-all;margin-bottom:6px}
  #detail .sec{margin-top:14px}
  #detail .sh{color:#58a6ff;font-size:10px;text-transform:uppercase;letter-spacing:.07em;
    margin-bottom:6px;display:flex;justify-content:space-between}
  #detail .sh span{color:var(--muted)}
  #detail .link{display:block;width:100%;text-align:left;background:none;border:0;
    color:var(--ink);font-family:var(--mono);font-size:11.5px;padding:5px 7px;border-radius:6px;
    cursor:pointer;word-break:break-word}
  #detail .link:hover{background:#ffffff10}
  #detail .link .loc{display:block;color:var(--muted);font-size:10px;margin-top:1px}
  #detail .none{color:var(--muted);font-style:italic;font-size:11px}
  footer{position:absolute;bottom:16px;right:26px;font-size:11px;color:var(--muted);
    font-family:var(--mono);pointer-events:none}
  @media(max-width:720px){.stats{display:none}#legend{max-width:56vw}}
</style>

<script>
const DATA = /*DATA*/;
const PALETTE = ["#2dd4bf","#fbbf24","#a78bfa","#fb7185","#38bdf8","#4ade80","#fb923c","#f472b6","#a3e635","#60a5fa","#facc15","#c084fc"];
const color = {}; DATA.repos.forEach((r,i)=>color[r]=PALETTE[i%PALETTE.length]);

const canvas=document.getElementById("c"),ctx=canvas.getContext("2d");
let W=0,H=0,DPR=1,alpha=1;
function resize(){DPR=Math.min(devicePixelRatio||1,2);
  W=canvas.clientWidth||innerWidth||1000;H=canvas.clientHeight||innerHeight||700;
  canvas.width=W*DPR;canvas.height=H*DPR;ctx.setTransform(DPR,0,0,DPR,0,0);placeCenters();alpha=Math.max(alpha,.3);}
addEventListener("resize",resize);

// repo cluster centers on a ring
const centers={};
function placeCenters(){const cx=W/2,cy=H/2+18,R=Math.min(W,H)*0.32;
  DATA.repos.forEach((r,i)=>{const a=(i/DATA.repos.length)*Math.PI*2-Math.PI/2;
    centers[r]={x:cx+Math.cos(a)*R,y:cy+Math.sin(a)*R};});}

// Establish real dimensions + cluster centers BEFORE seeding node positions,
// else centers is empty / W is 0 and every position seeds to NaN (blank canvas).
resize();

// nodes/links
const N=DATA.nodes.map(n=>({...n,x:0,y:0,vx:0,vy:0,r:n.role==="route"?4.5:n.role==="call"?4:2.6}));
const idx={};N.forEach((n,i)=>idx[n.id]=i);
const L=DATA.links.map(l=>({s:idx[l.s],t:idx[l.t],cross:l.cross,kind:l.kind,conf:l.conf})).filter(l=>l.s!=null&&l.t!=null);
const deg={};L.forEach(l=>{deg[l.s]=(deg[l.s]||0)+1;deg[l.t]=(deg[l.t]||0)+1;});
N.forEach((n,i)=>{n.r+=Math.min(3,(deg[i]||0)*0.25);});
// seed positions near cluster centers
N.forEach(n=>{const c=centers[n.repo]||{x:W/2,y:H/2};
  n.x=c.x+(Math.random()-.5)*120;n.y=c.y+(Math.random()-.5)*120;});
const adj=N.map(()=>[]);L.forEach(l=>{adj[l.s].push(l.t);adj[l.t].push(l.s);});

function step(){
  // charge repulsion (naive, capped neighborhood by grid would be nicer; n is small)
  for(let i=0;i<N.length;i++){const a=N[i];
    for(let j=i+1;j<N.length;j++){const b=N[j];
      let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy||1;
      if(d2<14000){const f=(a.repo===b.repo?260:520)/d2;
        const d=Math.sqrt(d2);dx/=d;dy/=d;a.vx+=dx*f;a.vy+=dy*f;b.vx-=dx*f;b.vy-=dy*f;}}}
  // links: springs (intra short & stiff, cross long & soft → clusters stay apart but joined)
  for(const l of L){const a=N[l.s],b=N[l.t];let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
    const rest=l.cross?190:34,k=l.cross?0.006:0.045,f=(d-rest)*k;dx/=d;dy/=d;
    a.vx+=dx*f;a.vy+=dy*f;b.vx-=dx*f;b.vy-=dy*f;}
  // cluster gravity toward repo center
  for(const n of N){const c=centers[n.repo];if(!c)continue;
    n.vx+=(c.x-n.x)*0.012;n.vy+=(c.y-n.y)*0.012;}
  for(const n of N){if(n===drag)continue;n.x+=n.vx*alpha;n.y+=n.vy*alpha;n.vx*=0.82;n.vy*=0.82;}
  if(alpha>0.05)alpha*=0.995;
}

let hover=-1,drag=null,selected=-1,press=null;
function draw(){
  const focus=hover>=0?hover:selected;
  ctx.clearRect(0,0,W,H);
  // links: http_calls (bright, curved, cross-service) > calls (function links) > contains (faint)
  for(const l of L){const a=N[l.s],b=N[l.t];
    const on=focus===l.s||focus===l.t;
    if(l.cross){ctx.strokeStyle=on?"#e6edf3":color[a.repo]+"99";ctx.lineWidth=on?2:1.2;}
    else if(l.kind==="calls"){ctx.strokeStyle=on?color[a.repo]+"dd":"#8b949e4d";ctx.lineWidth=on?1.4:0.9;}
    else{ctx.strokeStyle=on?"#e6edf333":"#30363d80";ctx.lineWidth=0.8;} // contains
    ctx.beginPath();ctx.moveTo(a.x,a.y);
    if(l.cross){const mx=(a.x+b.x)/2,my=(a.y+b.y)/2-Math.hypot(b.x-a.x,b.y-a.y)*0.12;
      ctx.quadraticCurveTo(mx,my,b.x,b.y);}else ctx.lineTo(b.x,b.y);
    ctx.stroke();}
  // nodes
  for(let i=0;i<N.length;i++){const n=N[i];
    const near=focus===i||(focus>=0&&adj[focus].includes(i));
    ctx.beginPath();ctx.arc(n.x,n.y,n.r+(i===selected?2.4:near?1.2:0),0,7);
    ctx.fillStyle=color[n.repo];ctx.globalAlpha=focus<0||near?1:0.3;ctx.fill();
    if(i===selected){ctx.globalAlpha=1;ctx.lineWidth=2;ctx.strokeStyle="#fff";ctx.stroke();}
    else if(n.role==="route"){ctx.globalAlpha=focus<0||near?1:0.3;ctx.lineWidth=1.4;
      ctx.strokeStyle="#0d1117";ctx.stroke();}
    ctx.globalAlpha=1;}
  // labels for the focused node + its neighbours — the "function names" view
  if(focus>=0){
    const ids=[focus,...adj[focus]].slice(0,16);
    ctx.font='11px ui-monospace,monospace';ctx.textBaseline="middle";
    for(const i of ids){const n=N[i];const t=n.label.length>34?n.label.slice(0,33)+"…":n.label;
      const w=ctx.measureText(t).width;const lx=n.x+n.r+5,ly=n.y;
      ctx.globalAlpha=i===focus?1:0.9;
      ctx.fillStyle="#0d1117d0";ctx.fillRect(lx-3,ly-8,w+6,16);
      ctx.fillStyle=i===focus?"#fff":"#c9d1d9";ctx.fillText(t,lx,ly+1);ctx.globalAlpha=1;}
  }
}
function tick(){step();draw();requestAnimationFrame(tick);}

// interaction
const tip=document.getElementById("tip");
const esc=s=>s.replace(/</g,"&lt;");
// Typed neighbors of a node, for the hover card.
function meta(i){
  const callsOut=[],callsIn=[],httpOut=[],httpIn=[],handlers=[];
  for(const l of L){
    if(l.kind==="calls"){ if(l.s===i)callsOut.push(N[l.t]); if(l.t===i)callsIn.push(N[l.s]); }
    else if(l.kind==="http_calls"){ if(l.s===i)httpOut.push(N[l.t]); if(l.t===i)httpIn.push(N[l.s]); }
    else if(l.kind==="contains"){ if(l.s===i&&N[l.t].role==="call")httpOut.push(N[l.t]); // fn → its call-sites
      if(l.s===i&&N[i].role==="route")handlers.push(N[l.t]); }
  }
  return {callsOut,callsIn,httpOut,httpIn,handlers};
}
function list(title,arr,fn){
  if(!arr.length)return"";
  const seen=new Set(),items=[];
  for(const n of arr){const k=fn(n);if(!seen.has(k)){seen.add(k);items.push(k);}}
  const shown=items.slice(0,6).map(esc).join("<br>");
  const more=items.length>6?'<div class="more">+'+(items.length-6)+" more</div>":"";
  return '<div class="sec"><div class="h">'+title+" · "+items.length+'</div>'+shown+more+"</div>";
}
function card(i){
  const n=N[i],m=meta(i);
  let h='<b>'+esc(n.label)+'</b><div class="r"><span class="sw" style="background:'+color[n.repo]+'"></span>'+n.repo+' · '+n.role+"</div>";
  if(n.role==="call")   h+=list("hits route",m.httpOut,x=>x.label+"  ("+x.repo+")");
  if(n.role==="route"){ h+=list("called from",m.httpIn,x=>x.repo); h+=list("handler",m.handlers,x=>x.label); }
  h+=list("HTTP calls",m.httpOut.filter(x=>x.role==="call"),x=>x.label);
  h+=list("calls",m.callsOut,x=>x.label);
  h+=list("called by",m.callsIn,x=>x.label);
  return h;
}
function pick(mx,my){let best=-1,bd=100;for(let i=0;i<N.length;i++){const n=N[i];
  const d=(n.x-mx)**2+(n.y-my)**2;if(d<bd&&d<(n.r+5)**2){bd=d;best=i;}}return best;}
// pinned detail panel — click a node, then click linked rows to walk the graph
const detail=document.getElementById("detail");
function drow(n){return '<button class="link" data-i="'+idx[n.id]+'">'+esc(n.label)+
  '<span class="loc">'+n.repo+' · '+esc(n.file)+':'+n.line+'</span></button>';}
function dsec(title,arr){if(!arr.length)return"";
  const seen=new Set(),items=[];for(const n of arr){if(!seen.has(n.id)){seen.add(n.id);items.push(n);}}
  return '<div class="sec"><div class="sh">'+title+'<span>'+items.length+'</span></div>'+items.map(drow).join("")+'</div>';}
function detailHTML(i){const n=N[i],m=meta(i);
  let h='<div class="close" data-close="1">×</div><div class="dlabel">'+esc(n.label)+'</div>'+
    '<div class="dmeta"><span class="sw" style="background:'+color[n.repo]+'"></span>'+n.repo+' · '+n.role+'</div>'+
    '<div class="dloc">'+esc(n.file)+':'+n.line+'</div>';
  if(n.role==="call")h+=dsec("Hits route",m.httpOut);
  if(n.role==="route"){h+=dsec("Called from",m.httpIn);h+=dsec("Handler",m.handlers);}
  h+=dsec("HTTP calls made",m.httpOut.filter(x=>x.role==="call"));
  h+=dsec("Calls",m.callsOut);
  h+=dsec("Called by",m.callsIn);
  if(!m.callsOut.length&&!m.callsIn.length&&!m.httpOut.length&&!m.httpIn.length&&!m.handlers.length)
    h+='<div class="none">No linked functions in the current view.</div>';
  return h;}
function select(i){selected=i;hover=-1;tip.hidden=true;alpha=Math.max(alpha,.4);
  detail.hidden=false;detail.innerHTML=detailHTML(i);}
function deselect(){selected=-1;detail.hidden=true;}
detail.addEventListener("click",e=>{
  if(e.target.closest("[data-close]"))return deselect();
  const b=e.target.closest(".link");if(b)select(+b.dataset.i);});

canvas.addEventListener("mousemove",e=>{
  const mx=e.clientX,my=e.clientY;
  if(drag){if(press){const dx=mx-press.x,dy=my-press.y;if(dx*dx+dy*dy>16)press.moved=true;}
    drag.x=mx;drag.y=my;drag.vx=drag.vy=0;alpha=Math.max(alpha,.5);return;}
  hover=pick(mx,my);
  if(hover>=0&&hover!==selected){tip.hidden=false;tip.innerHTML=card(hover);
    tip.style.left=Math.min(mx+16,W-tip.offsetWidth-12)+"px";
    tip.style.top=Math.min(my+16,H-tip.offsetHeight-12)+"px";}else tip.hidden=true;});
canvas.addEventListener("mousedown",e=>{const i=pick(e.clientX,e.clientY);
  press={i,x:e.clientX,y:e.clientY,moved:false};if(i>=0)drag=N[i];});
addEventListener("mouseup",()=>{
  if(press&&!press.moved){press.i>=0?select(press.i):deselect();}
  drag=null;press=null;});

// legend
const legend=document.getElementById("legend");
const counts={};N.forEach(n=>counts[n.repo]=(counts[n.repo]||0)+1);
const callers=new Set(L.filter(l=>l.cross).map(l=>N[l.s].repo));
const apis=new Set(L.filter(l=>l.cross).map(l=>N[l.t].repo));
DATA.repos.forEach(r=>{const role=apis.has(r)&&callers.has(r)?"api · caller":apis.has(r)?"api":callers.has(r)?"caller":"—";
  const row=document.createElement("div");row.className="lrow";
  row.innerHTML='<span class="sw" style="background:'+color[r]+'"></span>'+
    '<span class="lname">'+r+'</span><span class="lcount">'+counts[r]+' · '+role+'</span>';
  legend.appendChild(row);});

// Re-fit when the artifact iframe settles its layout (dimensions can be 0 at first paint).
if(window.ResizeObserver)new ResizeObserver(resize).observe(canvas);
resize();tick();
</script>`;

void main().catch((e) => { console.error(e); process.exit(1); });
