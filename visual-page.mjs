import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';

const maxPixels = 2_400_000;
const frameLifetime = 8000;
export const visualActions = Object.freeze(['click','hover','drag','scroll','key','tap','text']);
const fail = code => { throw Object.assign(new Error(code), {code}); };
const hash = value => createHash('sha256').update(value).digest('hex');
const finite = Number.isFinite;
const inRect = (x,y,r) => x >= r.x && y >= r.y && x < r.x+r.width && y < r.y+r.height;

function rectangle(rect,viewport) {
  if (!rect || !['x','y','width','height'].every(k => Number.isSafeInteger(rect[k])) ||
      rect.x<0 || rect.y<0 || rect.width<1 || rect.height<1 || rect.x+rect.width>viewport.width ||
      rect.y+rect.height>viewport.height || rect.width*rect.height>maxPixels) fail('invalid_visual_region');
  return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
}

// Use the browser's DOM/layout snapshot, including closed shadow trees. The
// page's DOM prototypes cannot redefine these node IDs or layout coordinates.
async function isolatedContext(session) {
  const {frameTree}=await session.send('Page.getFrameTree');
  const {executionContextId}=await session.send('Page.createIsolatedWorld',{
    frameId:frameTree.frame.id,worldName:'open-browser-visual'});
  return executionContextId;
}

async function measure(session, contextId, guarded=false) {
  const {cssVisualViewport:v}=await session.send('Page.getLayoutMetrics');
  const viewport={width:Math.floor(v.clientWidth),height:Math.floor(v.clientHeight),scrollX:v.pageX,scrollY:v.pageY,
    scale:v.scale,zoom:v.zoom || 1,offsetX:v.offsetX,offsetY:v.offsetY,deviceScaleFactor:(await session.send('Runtime.evaluate',{expression:'window.devicePixelRatio',contextId})).result.value};
  if (![viewport.scale,viewport.zoom,viewport.deviceScaleFactor].every(n=>finite(n)&&n>0)) fail('unsupported_visual_zoom');
  const {documents,strings} = await session.send('DOMSnapshot.captureSnapshot',{
    computedStyles:['visibility','filter','-webkit-box-reflect','backdrop-filter','opacity'],includePaintOrder:true });
  const doc = documents[0];
  if (!doc || doc.nodes.nodeName.length > 30000 || doc.layout.nodeIndex.length > 18000) fail('visual_layout_limit');
  const sensitive = new Set(), shadowHosts = new Set();
  for (const node of doc.nodes.shadowRootType?.index || []) {
    // Built-in controls have UA shadow trees, and custom closed shadow hosts
    // may contain private controls. Mask the entire host.
    shadowHosts.add(doc.nodes.parentIndex[node]);
  }
  for(let i=0;i<doc.nodes.nodeName.length;i++) {
    const tag = strings[doc.nodes.nodeName[i]];
    const values = doc.nodes.attributes[i] || [];
    let privateNode = ['INPUT','TEXTAREA','SELECT','IFRAME','FRAME','OBJECT','EMBED'].includes(tag) || shadowHosts.has(i);
    for(let a=0;a<values.length;a+=2) {
      const name=strings[values[a]], value=strings[values[a+1]];
      if(name==='data-open-browser-private' || (name==='contenteditable' && value!=='false') ||
          (name==='autocomplete' && /^(cc-|one-time-code)/.test(value))) privateNode=true;
    }
    if(privateNode || sensitive.has(doc.nodes.parentIndex[i])) sensitive.add(i);
  }
  const masks=[],layout=[],hiddenNodes=new Set();
  let complexPaint=false;
  for(let j=0;j<doc.layout.nodeIndex.length;j++) {
    const node = doc.layout.nodeIndex[j], b = doc.layout.bounds[j];
    const [visibility,filter,reflection,backdrop,opacity] = doc.layout.styles[j].map(k=>strings[k]);
    if(opacity==='0') hiddenNodes.add(node);
    layout.push([doc.nodes.backendNodeId[node],b,doc.layout.paintOrders[j],visibility]);
    if ([filter,reflection,backdrop].some(v=>v && v!=='none')) complexPaint=true;
    if(sensitive.has(node)) masks.push({x:b[0]/viewport.zoom-viewport.scrollX-2,y:b[1]/viewport.zoom-viewport.scrollY-2,
      width:b[2]/viewport.zoom+4,height:b[3]/viewport.zoom+4});
  }
  if(guarded) {
    for(const node of doc.layout.nodeIndex) {
      if(!sensitive.has(node)) continue;
      let parent=node;
      while(parent>=0 && !hiddenNodes.has(parent)) parent=doc.nodes.parentIndex[parent];
      if(parent<0) fail('visual_redaction_unavailable');
    }
  }
  if(masks.length && complexPaint) fail('visual_redaction_unavailable');
  const protectedNodes=new Set([...sensitive].map(i=>doc.nodes.backendNodeId[i]));
  const hosts=[...new Set([...shadowHosts].map(i=>strings[doc.nodes.nodeName[i]].toLowerCase()))];
  return {viewport,masks,protectedNodes,hosts,signature:hash(JSON.stringify([viewport,layout,masks]))};
}

// Read the current compositor surface. CDP's screenshot clip can temporarily
// change the visual viewport and reset a user's pinch zoom. Crop the surface
// locally and expose exactly one sample for each requested CSS pixel.
async function capturePixels(session,clip,v) {
  const ratio=v.deviceScaleFactor*v.scale;
  const width=Math.round(v.width*ratio),height=Math.round(v.height*ratio);
  if (width*height>16_000_000) fail('visual_frame_too_large');
  const {data}=await session.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
  const raw=Buffer.from(data,'base64');
  if(raw.length<24 || raw.readUInt32BE(16)*raw.readUInt32BE(20)>16_000_000) fail('visual_frame_too_large');
  const source=PNG.sync.read(raw);
  // Metrics are rounded down to whole CSS pixels. Permit the browser's
  // fractional last pixel but reject geometry that does not match this frame.
  if(Math.abs(source.width-width)>Math.ceil(ratio) || Math.abs(source.height-height)>Math.ceil(ratio))
    fail('visual_geometry_changed');
  const image=new PNG({width:clip.width,height:clip.height});
  const input=new Uint32Array(source.data.buffer,source.data.byteOffset,source.data.length/4);
  const output=new Uint32Array(image.data.buffer,image.data.byteOffset,image.data.length/4);
  for(let y=0;y<image.height;y++) {
    const sy=Math.min(source.height-1,Math.floor((clip.y+y+0.5)*ratio));
    for(let x=0;x<image.width;x++) {
      const sx=Math.min(source.width-1,Math.floor((clip.x+x+0.5)*ratio));
      output[y*image.width+x]=input[sy*source.width+sx];
    }
  }
  return image;
}

function redactImage(png,clip,masks) {
  for(const m of masks) {
    const left=Math.max(0,Math.floor(m.x-clip.x)), right=Math.min(png.width,Math.ceil(m.x+m.width-clip.x));
    const top=Math.max(0,Math.floor(m.y-clip.y)), bottom=Math.min(png.height,Math.ceil(m.y+m.height-clip.y));
    for(let y=top;y<bottom;y++) for(let x=left;x<right;x++) png.data.writeUInt32BE(0x000000ff,(y*png.width+x)*4);
  }
  const clean = PNG.sync.write(png);
  if(clean.length>3*1024*1024) fail('visual_frame_too_large');
  return clean;
}

// Suppress private paint in the renderer as well as blacking out its known
// bounds. A moving control, overflowing glyph, or frame cannot paint its
// visible content between the two layout measurements. The isolated world
// keeps the stylesheet and DOM access independent of page JS prototypes.
async function maskedCapture(session,contextId,clip,initial) {
  const selectors=['input','textarea','select','iframe','frame','object','embed','[data-open-browser-private]',
    '[contenteditable]:not([contenteditable="false" i])','[autocomplete*="cc-" i]','[autocomplete*="one-time-code" i]'];
  for(const host of initial.hosts) {
    if(!/^[a-z][a-z0-9-]*$/.test(host)) fail('visual_redaction_unavailable');
    selectors.push(host);
  }
  const scope=':is('+selectors.join(',')+')';
  const rule=scope+', '+scope+' *, '+scope+'::before, '+scope+'::after {opacity:0!important;transition:none!important}';
  const {result}=await session.send('Runtime.evaluate',{contextId,expression:`(() => {
    const sheet=new CSSStyleSheet();sheet.replaceSync(${JSON.stringify(rule)});
    document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];return sheet;
  })()`});
  if(!result.objectId) fail('visual_redaction_unavailable');
  try {
    const before=await measure(session,contextId,true);
    if(before.signature!==initial.signature) fail('stale_visual_frame');
    const data=await capturePixels(session,clip,before.viewport);
    const after=await measure(session,contextId,true);
    if(before.signature!==after.signature) fail('stale_visual_frame');
    return redactImage(data,clip,before.masks);
  } finally {
    await session.send('Runtime.callFunctionOn',{objectId:result.objectId,
      functionDeclaration:'function(){ document.adoptedStyleSheets=document.adoptedStyleSheets.filter(sheet=>sheet!==this) }'})
      .catch(()=>{});
  }
}

export function validateVisualAction(action) {
  const types={click:[],hover:[],tap:[],drag:['toX','toY'],scroll:['deltaX','deltaY'],key:['keys'],text:['text']};
  if(!action || !Object.hasOwn(types,action.type) || !finite(action.x) || !finite(action.y) ||
      Object.keys(action).some(k=>!['type','x','y',...types[action.type]].includes(k))) fail('invalid_visual_action');
  if(action.type==='drag' && ![action.toX,action.toY].every(finite)) fail('invalid_visual_action');
  if(action.type==='scroll' && ![action.deltaX,action.deltaY].every(v=>finite(v)&&Math.abs(v)<=1600)) fail('invalid_visual_action');
  if(action.type==='key' && (!Array.isArray(action.keys) || !action.keys.length || action.keys.length>3 ||
      !action.keys.every((k,i)=>typeof k==='string' && (i<action.keys.length-1 ? /^(Control|Shift|Alt|Meta)$/.test(k) :
      /^(Tab|Enter|Escape|Space|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|[a-z0-9])$/.test(k))))) fail('invalid_visual_action');
  if(action.type==='text' && (typeof action.text!=='string'||!action.text.length||action.text.length>2048)) fail('invalid_visual_action');
}

export class VisualPages {
  permissions = new WeakMap();
  frames = new WeakMap();
  active = 0;
  enabled = process.env.OPEN_BROWSER_DISABLE_VISUAL !== '1';

  revokeActor(ws, principalId) {
    const grants=this.permissions.get(ws);
    if(!grants) return;
    for(const key of grants.keys()) if(JSON.parse(key)[0]===principalId) grants.delete(key);
  }

  permission(ws, {principalId,origin,allow}) {
    const u=URL.parse(origin);
    if(typeof principalId!=='string'||!principalId||principalId.length>160||typeof allow!=='boolean'||
      !u||!['http:','https:'].includes(u.protocol)||u.origin!==origin||!ws.origins.has(origin)) fail('invalid_pixel_permission');
    let grants=this.permissions.get(ws);
    if(!grants){ grants=new Map(); this.permissions.set(ws,grants); }
    const key=JSON.stringify([principalId,origin]);
    if(allow) grants.set(key,randomUUID()); else grants.delete(key);
    return {principalId,origin,allow};
  }

  authority(ws,tab,actor,mode) {
    if(!this.enabled) fail('visual_disabled');
    if(ws.mode!==mode || ws.finishing) fail('stale_control');
    if(ws.pages.get(tab.id)!==tab || tab.page.isClosed()) fail('page_not_found');
    const url=URL.parse(tab.page.url());
    if(!url || !['http:','https:'].includes(url.protocol)||url.username||url.password||!ws.origins.has(url.origin)) fail('origin_denied');
    const grant=this.permissions.get(ws)?.get(JSON.stringify([actor,url.origin]));
    if(!grant) fail('pixel_permission_required');
    return {origin:url.origin,grant,documentId:tab.documentId,controlGeneration:ws.generation};
  }

  async capture(ws,tab,actor,params,mode) {
    const auth=this.authority(ws,tab,actor,mode);
    if(params.ref!==undefined && params.region!==undefined) fail('invalid_visual_region');
    if(tab.visualBusy || this.active>=3 || Date.now()-(tab.visualCaptureAt||0)<150) fail('frame_busy');
    tab.visualCaptureAt=Date.now(); tab.visualBusy=true; this.active++;
    let session;
    try {
      session=await tab.page.context().newCDPSession(tab.page);
      const contextId=await isolatedContext(session);
      const initial=await measure(session,contextId);
      const v=initial.viewport;
      let region=params.region;
      if(params.ref!==undefined) {
        const handle=tab.refs.get(params.ref);
        const bounds=await handle?.boundingBox();
        if(!bounds) fail('stale_ref');
        region={x:Math.floor(bounds.x-v.offsetX),y:Math.floor(bounds.y-v.offsetY),width:Math.ceil(bounds.width),height:Math.ceil(bounds.height)};
      }
      const clip=rectangle(region ?? {x:0,y:0,width:v.width,height:v.height},v);
      const pixels=await maskedCapture(session,contextId,clip,initial);
      const final=await measure(session,contextId);
      const current=this.authority(ws,tab,actor,mode);
      if(JSON.stringify(auth)!==JSON.stringify(current)||initial.signature!==final.signature) fail('stale_visual_frame');
      await session.detach();session=null;
      if(JSON.stringify(auth)!==JSON.stringify(this.authority(ws,tab,actor,mode))) fail('stale_visual_frame');
      ws.lastVisualCapture={pageId:tab.id,principalId:actor,origin:auth.origin,clip,at:Date.now()};
      const frameId=randomUUID();
      this.frames.set(tab,{...auth,actor,mode,clip,frameId,expires:Date.now()+frameLifetime,signature:initial.signature,
        // Retain only a digest, so changed paint on canvas is detected without saving its pixels.
        pixelDigest:hash(pixels)});
      return {workspaceId:ws.id,pageId:tab.id,frameId,documentId:auth.documentId,controlGeneration:auth.controlGeneration,
        origin:auth.origin,mimeType:'image/png',data:pixels.toString('base64'),clip,viewport:{width:v.width,height:v.height},
        pixelWidth:clip.width,pixelHeight:clip.height,scale:v.scale,zoom:v.zoom,deviceScaleFactor:v.deviceScaleFactor};
    } finally { if(session) await session.detach().catch(()=>{}); tab.visualBusy=false; this.active--; }
  }

  async input(ws,tab,actor,params,mode,dispatch=()=>{}) {
    const auth=this.authority(ws,tab,actor,mode);
    const frame=this.frames.get(tab);
    const check=()=>{
      const live=this.authority(ws,tab,actor,mode);
      if(!frame||frame.actor!==actor||frame.mode!==mode||live.grant!==frame.grant||live.origin!==frame.origin||
        frame.frameId!==params.frameId||frame.expires<Date.now()||tab.documentId!==params.documentId||
        auth.documentId!==frame.documentId||ws.generation!==params.controlGeneration||auth.controlGeneration!==frame.controlGeneration)
        fail('stale_visual_frame');
    };
    check(); validateVisualAction(params.action);
    if(tab.visualBusy || this.active>=3) fail('frame_busy');
    tab.visualBusy=true;this.active++;
    this.frames.delete(tab);
    let session;
    const {page}=tab, action=params.action;
    const held=[];
    let button=false,touch=false;
    try {
      session=await page.context().newCDPSession(page);
      const executionContextId=await isolatedContext(session);
      const layout=await measure(session,executionContextId);
      if(layout.signature!==frame.signature) fail('stale_visual_frame');
      const pixels=await maskedCapture(session,executionContextId,frame.clip,layout);
      if(hash(pixels)!==frame.pixelDigest || (await measure(session,executionContextId)).signature!==layout.signature)
        fail('stale_visual_frame');
      async function point(x,y,verifyFocus=false) {
        check();
        if(!inRect(x,y,frame.clip) || layout.masks.some(m=>inRect(x,y,m))) fail('visual_target_denied');
        const hitX=x+layout.viewport.offsetX,hitY=y+layout.viewport.offsetY;
        const expression=`(() => {
          const node=document.elementFromPoint(${hitX},${hitY});
          if(!node || node.closest('input, textarea, select, iframe, frame, object, embed, [data-open-browser-private], [contenteditable]:not([contenteditable="false" i]), [inert], [disabled], [aria-disabled="true"]')) return null;
          const active=document.activeElement;
          if(${verifyFocus} && (!active || active===document.body || (active!==node && !active.contains(node)))) return null;
          return node;
        })()`;
        const {result}=await session.send('Runtime.evaluate',{expression,contextId:executionContextId});
        if(!result.objectId) fail('visual_target_denied');
        const {node}=await session.send('DOM.describeNode',{objectId:result.objectId});
        if(!node.backendNodeId || layout.protectedNodes.has(node.backendNodeId)) fail('visual_target_denied');
        check();
      }
      await point(action.x,action.y,['key','text'].includes(action.type));
      if(action.type==='drag') for(let i=1;i<=12;i++) await point(action.x+(action.toX-action.x)*i/12,action.y+(action.toY-action.y)*i/12);
      check(); dispatch();
      if(action.type==='tap') {
        await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:action.x,y:action.y}]});
        touch=true;check();await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});touch=false;
      } else if(action.type==='key') {
        for(const key of action.keys){check();await page.keyboard.down(key);held.push(key);}
      } else if(action.type==='text') await page.keyboard.insertText(action.text);
      else {
        await page.mouse.move(action.x,action.y);
        await point(action.x,action.y);
        if(action.type==='scroll') await page.mouse.wheel(action.deltaX,action.deltaY);
        if(['click','drag'].includes(action.type)) {
          await page.mouse.down();button=true;
          if(action.type==='drag') for(let i=1;i<=12;i++) {
            const x=action.x+(action.toX-action.x)*i/12,y=action.y+(action.toY-action.y)*i/12;
            await point(x,y);await page.mouse.move(x,y);
          }
          check();await page.mouse.up();button=false;
        }
      }
      return {accepted:true};
    } finally {
      for(const key of held.reverse()) await page.keyboard.up(key).catch(()=>{});
      if(button){await page.mouse.move(-1,-1).catch(()=>{});await page.mouse.up().catch(()=>{});}
      if(touch) await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]}).catch(()=>{});
      if(session) await session.detach().catch(()=>{});
      tab.visualBusy=false;this.active--;
    }
  }
}
