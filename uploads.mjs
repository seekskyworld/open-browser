import {randomUUID} from 'node:crypto';

const maxFileBytes = 8 * 1024 * 1024;
function fail(code) { throw Object.assign(new Error(code), {code}); }

// Only the trusted desktop can supply the chosen file bytes. Grants never contain a path.
export class UploadGrants {
  constructor() { this.entries = new Map(); }
  remove(id) {
    const entry=this.entries.get(id);
    if (entry) { clearTimeout(entry.timer); this.entries.delete(id); }
  }
  clear() { for (const id of this.entries.keys()) this.remove(id); }
  list() { return [...this.entries.values()].map(entry=>entry.info); }
  grant(ws,tab,params) {
    const {name,mimeType='',data,origin,documentId,controlGeneration} = params;
    if (ws.mode !== 'agent' || ws.generation !== controlGeneration || tab.documentId !== documentId)
      fail('stale_control');
    if (!ws.origins.has(origin) || URL.parse(tab.page.url())?.origin !== origin) fail('origin_denied');
    if (typeof data !== 'string' || data.length > 4*Math.ceil(maxFileBytes/3) ||
        typeof name !== 'string' || !name.length || name.length>180 || /[\/\\\p{Cc}]/u.test(name) ||
        name === '.' || name === '..' || typeof mimeType !== 'string' || mimeType.length>128) fail('invalid_file');
    const buffer=Buffer.from(data,'base64');
    if (buffer.length > maxFileBytes || buffer.toString('base64') !== data) fail('invalid_file');
    if (this.entries.size>=4 || this.list().reduce((n,e)=>n+e.size,buffer.length)>2*maxFileBytes) fail('file_budget');
    const fileId=randomUUID(), expiresAt=Date.now()+300_000;
    const info={fileId,pageId:tab.id,documentId,controlGeneration,origin,name,size:buffer.length,expiresAt};
    const timer=setTimeout(()=>this.remove(fileId),300_000).unref();
    this.entries.set(fileId,{info,payload:{name,mimeType,buffer},timer});
    return info;
  }
  get(ws,tab,id) {
    const entry=this.entries.get(id);
    if (!entry || entry.info.expiresAt<=Date.now() || entry.info.controlGeneration!==ws.generation ||
        entry.info.pageId!==tab.id || entry.info.documentId!==tab.documentId || !ws.origins.has(entry.info.origin) ||
        entry.info.origin!==URL.parse(tab.page.url())?.origin || ws.mode!=='agent') fail('file_grant_invalid');
    return entry;
  }
}

export async function chooseGrantedFile(ws,tab,el,id,beforeDispatch,check) {
  ws.uploads.get(ws,tab,id);
  // Register the chooser before dispatch. Many pages create a detached input during click.
  let receive, timer;
  const chosen=new Promise((resolve,reject)=>{
    receive=resolve;
    timer=setTimeout(()=>reject(Object.assign(new Error('file_chooser_timeout'),{code:'file_chooser_timeout'})),5000);
    tab.page.once('filechooser',receive);
  });
  try {
    beforeDispatch();
    const [chooser]=await Promise.all([chosen,el.click({timeout:5000})]);
    const frame=await chooser.element().ownerFrame();
    if (frame!==tab.page.mainFrame()) fail('file_origin_mismatch');
    check();
    const {payload}=ws.uploads.get(ws,tab,id);
    ws.uploads.remove(id);
    await chooser.setFiles(payload,{timeout:5000});
  } finally {
    clearTimeout(timer);
    tab.page.off('filechooser',receive);
  }
}
