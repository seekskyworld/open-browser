// A page can only ask for a URL. The host decides ownership, origin and generation
// before a background target exists. Chromium's document sandbox keeps its native
// popup capability disabled, including for frames and unregistered pages.
export async function installPopupBridge(page, accept) {
  const binding = '__openBrowserPopupRequest';
  const exposed = await page.exposeBinding(binding, ({frame}, token, url) => {
    if (frame !== page.mainFrame() || typeof token !== 'string' || typeof url !== 'string' || url.length>8192) return;
    return accept(token,url);
  });
  const script = await page.addInitScript(bindingName => {
    if (window !== top) return;
    const nativeOpen=window.open, nativeTimeout=window.setTimeout;
    const request=(...args)=>window[bindingName](...args).catch(()=>{});
    let armed, current;
    function onClick(event) {
      if (!event.isTrusted || !armed) return;
      const token=armed;
      armed=undefined;current=token;
      request(token,'');
      nativeTimeout.call(window,()=>{if(current===token)current=undefined;},0);
    }
    window.addEventListener('click',onClick,true);
    window.__openBrowserArmPopup=token=>{armed=token;};
    function managedOpen(url, target='_blank') {
      if (!current || !url || ['_self','_top','_parent'].includes(String(target).toLowerCase())) return null;
      try { request(current,new URL(String(url),document.baseURI).href); } catch { /* Invalid URL. */ }
      return null;
    }
    // Propagate only the initiating click's capability to its own timer callbacks.
    function managedTimeout(callback,ms,...args) {
      const token=current;
      if (!token || typeof callback!=='function') return nativeTimeout.call(window,callback,ms,...args);
      return nativeTimeout.call(window,function(...params){
        const previous=current;current=token;
        try { return callback.apply(this,params); } finally {current=previous;}
      },ms,...args);
    }
    window.open=managedOpen;
    window.setTimeout=managedTimeout;
    window.__openBrowserReleasePopups=()=>{
      window.removeEventListener('click',onClick,true);
      if (window.open===managedOpen) window.open=nativeOpen;
      if (window.setTimeout===managedTimeout) window.setTimeout=nativeTimeout;
      armed=current=undefined;
      delete window.__openBrowserArmPopup;
      delete window.__openBrowserReleasePopups;
    };
  }, binding);
  return async () => {
    await script.dispose();
    await exposed.dispose();
    await page.evaluate(()=>window.__openBrowserReleasePopups?.()).catch(()=>{});
  };
}
