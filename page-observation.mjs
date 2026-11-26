export function inspectDocument(options = {}) {
  const textOnly = options === true || options.textOnly;
  if (options.origins && (!options.origins.includes(self.origin) || !options.origins.includes(location.origin))) return null;
  const excluded = '[aria-hidden="true" i],[inert],[data-open-browser-private]';
  // closest() stops at a shadow boundary. Walk the composed ancestry so a
  // private or inert host also protects its projected and shadow children.
  function composedMatch(el, selector) {
    for(let node=el;node;node=node.assignedSlot || node.parentElement || node.getRootNode().host)
      if(node.matches(selector)) return true;
    return false;
  }
  const visible = node => node.checkVisibility({visibilityProperty:true,opacityProperty:true}) &&
    node.getClientRects().length>0 && !composedMatch(node,excluded);
  const disabled = node => node.matches(':disabled') || composedMatch(node,'[aria-disabled="true" i]');
  const region = options.region;
  function intersects(el) {
    if(!region) return true;
    const r=el.getBoundingClientRect();
    return r.right>region.x && r.left<region.x+region.width && r.bottom>region.y && r.top<region.y+region.height;
  }
  function* walk(root,mask) {
    const stack=[document.createTreeWalker(root,mask | NodeFilter.SHOW_ELEMENT)];
    while(stack.length) {
      const node=stack.at(-1).nextNode();
      if(!node) {stack.pop();continue;}
      if(node.shadowRoot) stack.push(document.createTreeWalker(node.shadowRoot,mask | NodeFilter.SHOW_ELEMENT));
      yield node;
    }
  }
  function textWindow(root,limit,offset=0,scoped=false) {
    let content='',position=0;
    const protectedText='script,style,noscript,input,textarea,select,[contenteditable]';
    for(const node of walk(root,NodeFilter.SHOW_TEXT)) {
      if(node.nodeType!==Node.TEXT_NODE) continue;
      const el=node.parentElement || node.getRootNode().host;
      if(!el || !visible(el) || composedMatch(el,protectedText) || (scoped && !intersects(el))) continue;
      const value=node.textContent.trim();
      if(!value) continue;
      const piece=(position?' ':'')+value;
      const start=Math.max(0,offset-position);
      position+=piece.length;
      if(start<piece.length) content+=piece.slice(start,start+limit+1-content.length);
      if(content.length>limit) break;
    }
    return {text:content.slice(0,limit),more:content.length>limit};
  }
  const visibleText=(root,limit)=>textWindow(root,limit).text;
  // Native top-layer dialogs follow paint order, which can differ from DOM order.
  const modalSelector='dialog:modal,[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]';
  const dialogs=[...document.querySelectorAll(modalSelector)];
  for(let focused=document.activeElement;focused?.shadowRoot?.activeElement;) {
    const root=focused.shadowRoot;
    dialogs.push(...root.querySelectorAll(modalSelector));
    focused=root.activeElement;
  }
  const painted=dialogs.filter(el=>el.checkVisibility({visibilityProperty:true,opacityProperty:true}) && el.getClientRects().length);
  const front=painted.findLast(el=>{
    const r=el.getBoundingClientRect();
    const hit=el.getRootNode().elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return hit && (el===hit || el.contains(hit));
  }) ?? painted.at(-1);
  if(options.foregroundTarget) {
    if(!front) return true;
    for(let node=options.foregroundTarget;node;node=node.assignedSlot || node.parentElement || node.getRootNode().host)
      if(node===front) return true;
    return false;
  }
  let foreground;
  if(front && visible(front)) {
    const label=(front.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id=>front.getRootNode().getElementById(id)).filter(el=>el && visible(el))
      .map(el=>visibleText(el,160)).join(' ');
    const {x,y,width,height}=front.getBoundingClientRect();
    foreground={role:front.getAttribute('role') || 'dialog',name:(label || front.getAttribute('aria-label') || '').slice(0,160),
      bounds:{x,y,width,height}};
  }
  const nodes=[],details=[];
  function stateOf(el) {
    const state = {};
    for (const key of ['checked', 'pressed', 'expanded', 'selected']) {
      const raw = el.getAttribute('aria-' + key);
      if (raw === 'true' || raw === 'false') state[key] = raw === 'true';
      else if (raw === 'mixed' && (key === 'checked' || key === 'pressed')) state[key] = raw;
    }
    if (el.matches('input[type="checkbox"],input[type="radio"]'))
      state.checked = el.indeterminate && el.type === 'checkbox' ? 'mixed' : el.checked;
    return state;
  }
  const selector='[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="option"],a[href],button,input,textarea,select,label,[role="button"],[role="link"],[contenteditable="true"]';
  const offset=options.elementOffset===undefined?0:options.elementOffset;
  const limit=options.limit??180;
  let seen=0,moreControls=false;
  const locator=options.locator;
  const candidates=[];
  let matchCount=0;
  function semanticScope(el, wanted) {
    for(let parent=el.parentElement || el.getRootNode().host; parent;
        parent=parent.assignedSlot || parent.parentElement || parent.getRootNode().host) {
      const role=parent.getAttribute('role') || {section:'region',tr:'row',fieldset:'group',form:'form',dialog:'dialog'}[parent.localName];
      if(!['region','row','group','form','dialog','listitem','article'].includes(role)) continue;
      const labelled=(parent.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map(id=>parent.getRootNode().getElementById(id)).filter(node=>node && visible(node))
        .map(node=>visibleText(node,160)).join(' ');
      const name=(labelled || parent.getAttribute('aria-label') || visibleText(parent,160)).slice(0,160);
      if(!wanted || (role===wanted.role && name===wanted.name)) return {role,name};
    }
  }
  function add(el,detail) {
    if(locator) {
      if(detail.role!==locator.role || detail.name!==locator.name) return;
      const within=semanticScope(el,locator.within);
      if(locator.within && !within) return;
      matchCount++;
      if(candidates.length<8) candidates.push({role:detail.role,name:detail.name,...(within && {within})});
      if(matchCount===1) {nodes.push(el);details.push(detail);}
      if(matchCount===2) {nodes.length=0;details.length=0;}
      return;
    }
    if(options.name && !detail.name.toLowerCase().includes(options.name.toLowerCase())) return;
    if(seen++<offset) return;
    if(nodes.length===limit) {moreControls=true;return;}
    nodes.push(el);details.push(detail);
  }
  for(const el of textOnly || offset===null ? [] : walk(front || document,NodeFilter.SHOW_ELEMENT)) {
    if(moreControls) break;
    if(!el.matches(selector) || !intersects(el)) continue;
    if (!visible(el) || disabled(el) || el.matches('input[type="hidden"]')) continue;
    if (el instanceof HTMLLabelElement && !el.matches('[role="button"],[role="link"],[contenteditable="true"]')) {
      // Chromium dispatches the native activation through the visible label.
      // Keep the ref on the control when the control already has a target.
      const control = el.control;
      if (!control || composedMatch(control,excluded) || disabled(control) || visible(control) ||
          !control.matches('input[type="checkbox"],input[type="radio"]')) continue;
      const name = visibleText(el, 160);
      if (name) add(el,{role:'label',name,...stateOf(control)});
      continue;
    }
    const type = el.type || '';
    let role = el.getAttribute('role') || 'textbox';
    if (el.matches('a,[role="link"]')) role = 'link';
    else if (el.matches('button,[role="button"],input[type="submit"],input[type="button"]')) role = 'button';
    else if (el.matches('select')) role = 'combobox';
    else if (['checkbox', 'radio'].includes(type)) role = type;
    const labels = Array.from(el.labels || []).filter(visible).map(label => visibleText(label, 160)).join(' ');
    const caption = ['button', 'link'].includes(role) ? visibleText(el, 160) : '';
    const submitText = el.matches('input[type="submit"],input[type="button"]') ? el.value : '';
    let referenced = '';
    for (const id of (el.getAttribute('aria-labelledby') || '').match(/\S+/g) || []) {
      const label = el.getRootNode().getElementById(id);
      if (!label || !visible(label)) continue;
      const part = visibleText(label, 160 - referenced.length);
      if (part) referenced += (referenced ? ' ' : '') + part;
      if (referenced.length >= 160) break;
    }
    const name = referenced || el.getAttribute('aria-label') || labels || caption || submitText
      || el.getAttribute('placeholder') || el.getAttribute('name') || role;
    const choices = role === 'combobox' ? Array.from(el.options).slice(0, 64)
      .map(option => ({ label: option.label.slice(0, 160), value: option.value.slice(0, 256) })) : undefined;
    add(el,{ role, name: name.trim().slice(0,160), ...stateOf(el), ...(choices && {options:choices}) });
  }
  const textOffset=options.textOffset===undefined?0:options.textOffset;
  const textLimit=options.textLimit??8000,padding=options.padding??0;
  const start=Math.max(0,(textOffset??0)-padding);
  const skip=(textOffset??0)-start;
  const window=locator || options.name || textOffset===null ? {text:'',more:false} :
    textWindow(front || document.body || document.documentElement,textLimit+skip+padding,start,true);
  const text=window.text.slice(skip,skip+textLimit);
  const more=window.more || window.text.length>skip+textLimit;
  const textWindowInfo=padding ? {padded:window.text,skip,length:text.length} : undefined;
  if (options.origins && textOnly) return {origin:self.origin,text,textWindowInfo};
  if (textOnly) return text;
  const next=moreControls || more ? {elementOffset:moreControls?offset+nodes.length:null,textOffset:more?textOffset+text.length:null} : null;
  if (options.expectedNode) return nodes.length===1 && nodes[0]===options.expectedNode;
  const match=locator ? {status:matchCount===1?'unique':matchCount?'ambiguous':'missing',count:matchCount,candidates} : undefined;
  const summary={text,details,next,origin:self.origin,textWindowInfo,foreground,...(match && {match})};
  if (options.summaryOnly) return summary;
  if (!options.previousNodes) return {nodes,summary};
  // Match the DOM objects themselves. Reordering or duplicate labels cannot
  // redirect an old ref to a replacement element.
  const previous = new Map(options.previousNodes.map((node, index) => [node, index]));
  const freshNodes = {};
  const previousIndices = nodes.map((node, index) => {
    if (previous.has(node)) return previous.get(node);
    freshNodes[index] = node;
    return -1;
  });
  return { nodes, freshNodes, summary:{...summary,previousIndices} };
}

// Only delegated readers use this path. Owners retain Playwright element handles for actions.
export async function readDocumentSummary(tab, origins, options = {}) {
  if (!tab.summarySession) tab.summarySession = await tab.page.context().newCDPSession(tab.page);
  const session = tab.summarySession;
  const allowed = JSON.stringify(origins);
  const expression = `(${allowed}.includes(self.origin) && ${allowed}.includes(location.origin)) ? (${inspectDocument})(${JSON.stringify(options)}).summary : null`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!tab.summaryContext || tab.summaryContext.documentId !== tab.documentId) {
      const documentId = tab.documentId;
      const {frameTree} = await session.send('Page.getFrameTree');
      const {executionContextId} = await session.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id, worldName: 'open-browser-observer',
      });
      tab.summaryContext = { documentId, executionContextId };
    }
    let response;
    try {
      response = await session.send('Runtime.evaluate', {
        contextId: tab.summaryContext.executionContextId, expression, returnByValue: true,
      });
    } catch (error) {
      // A renderer may invalidate the world before its navigation event reaches the service.
      if (attempt || !/context/i.test(error.message)) throw error;
      tab.summaryContext = undefined;
      continue;
    }
    if (response.exceptionDetails) throw new Error('observation_failed');
    if (!response.result.value) throw Object.assign(new Error('origin_denied'), {code:'origin_denied'});
    return response.result.value;
  }
}

export async function frameAllowed(frame,origins) {
  for(let child=frame; child.parentFrame(); child=child.parentFrame()) {
    const url=URL.parse(child.url());
    if(child.isDetached() || !url || !['http:','https:'].includes(url.protocol) ||
        url.username || url.password || !origins.has(url.origin)) return false;
    const owner=await child.frameElement();
    try {
      if(!await child.parentFrame().evaluate(inspectDocument,{foregroundTarget:owner})) return false;
      const sandbox=await owner.getAttribute('sandbox');
      if(sandbox!==null && !sandbox.split(/\s+/).includes('allow-same-origin')) return false;
      if(!await owner.evaluate(node=>{
        if(!node.checkVisibility({visibilityProperty:true,opacityProperty:true}) || !node.getClientRects().length) return false;
        for(let el=node;el;el=el.assignedSlot || el.parentElement || el.getRootNode().host)
          if(el.matches('[inert],[aria-hidden="true" i],[data-open-browser-private]')) return false;
        return true;
      })) return false;
    } finally { await owner.dispose().catch(()=>{}); }
  }
  return true;
}

export async function observeFrames(page, origins, redact, padding=0) {
  const frames = [];
  let remaining = 8000;
  // Direct visible child frames only. A blank or opaque sandbox has no
  // explicit HTTP(S) origin. No cross-frame action handles leave this helper.
  for (const frame of page.mainFrame().childFrames().slice(0, 16)) {
    if (!remaining || !origins.has(URL.parse(frame.url())?.origin)) continue;
    try {
      if (!(await frameAllowed(frame,origins))) continue;
      const data=await frame.evaluate(inspectDocument,{textOnly:true,origins:[...origins],textLimit:remaining,padding});
      if (data && origins.has(data.origin) && URL.parse(frame.url())?.origin === data.origin) {
        const text = redact(data.text,data.textWindowInfo);
        frames.push({ origin: data.origin, text });
        remaining -= data.text.length;
      }
    } catch (error) {
      if (!frame.isDetached() && !/context was destroyed|navigat/i.test(error.message)) throw error;
    }
  }
  return frames;
}

export function observationDelta(before, after) {
  const removed = before.elements.map(({role, name}) => ({role, name}));
  const added = [];
  for (const {role, name} of after.elements) {
    const index = removed.findIndex(item => item.role === role && item.name === name);
    if (index < 0) added.push({role, name});
    else removed.splice(index, 1);
  }
  const textChanged = before.text !== after.text;
  const oldByRef = new Map(before.elements.map(item => [item.ref, item]));
  const changed = after.elements.filter(item => {
    const old = oldByRef.get(item.ref);
    return old && ['checked','pressed','expanded','selected'].some(key => item[key] !== old[key]);
  });
  return { ...(changed.length && {changed}), textChanged, ...(textChanged && { text: after.text }), added, removed };
}
