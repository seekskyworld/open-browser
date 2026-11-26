import { perform } from './action-execution.mjs';
// A template describes a site, semantic controls and success conditions. Runtime
// bindings refer to grants previously issued by the local service.
export const workflowOrigin=Symbol('workflowOrigin');
const stateTypes={checked:[true,false,'mixed'],pressed:[true,false,'mixed'],selected:[true,false],expanded:[true,false]};

function invalid() {
  throw Object.assign(new Error('invalid_workflow'),{code:'invalid_workflow'});
}
function fields(value,allowed) {
  if(!value || typeof value!=='object' || Array.isArray(value) ||
     Object.keys(value).some(key=>!allowed.includes(key))) invalid();
}
function string(value,limit) {
  if(typeof value!=='string' || !value.trim() || value.length>limit) invalid();
  return value;
}
function target(value,allowScope=true) {
  fields(value,allowScope ? ['role','name','within'] : ['role','name']);
  const {role,name,within}=value;
  return {role:string(role,80),name:string(name,160),...(within!==undefined && {within:target(within,false)})};
}

export function workflowRequest(params) {
  const {workflow,bindings={},workspaceId,pageId,documentId,controlGeneration,operationId,timeoutMs}=params;
  fields(params,['workflow','bindings','workspaceId','pageId','documentId','controlGeneration','operationId','timeoutMs']);
  if(timeoutMs!==undefined && (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000)) invalid();
  fields(workflow,['version','origin','steps']);
  if(workflow.version!==1 || !Array.isArray(workflow.steps) || !workflow.steps.length || workflow.steps.length>32) invalid();
  const origin=URL.parse(workflow.origin);
  if(!origin || !['http:','https:'].includes(origin.protocol) || origin.origin!==workflow.origin) invalid();
  if(!bindings || typeof bindings!=='object' || Array.isArray(bindings)) invalid();
  const keys=new Set();
  const actions=workflow.steps.map(step=>{
    const action={kind:step?.kind,target:target(step?.target)};
    switch(action.kind) {
      case 'click':
        fields(step,['kind','target']);
        break;
      case 'fillCredential':
      case 'upload': {
        fields(step,['kind','target','binding']);
        const name=string(step.binding,80);
        if(!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || !Object.hasOwn(bindings,name)) invalid();
        keys.add(name);
        action[action.kind==='upload'?'fileId':'credentialRef']=string(bindings[name],160);
        break;
      }
      case 'expect':
        fields(step,['kind','target','state','timeoutMs']);
        if(step.state!==undefined) fields(step.state,Object.keys(stateTypes));
        for(const [key,value] of Object.entries(step.state ?? {})) {
          if(!stateTypes[key].includes(value)) invalid();
        }
        if(step.timeoutMs!==undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs<1 || step.timeoutMs>10000)) invalid();
        action.state=step.state ?? {};
        action.timeoutMs=step.timeoutMs ?? 5000;
        break;
      default: invalid();
    }
    return action;
  });
  fields(bindings,[...keys]);
  return {workspaceId,pageId,documentId,controlGeneration,operationId, ...(timeoutMs!==undefined && {timeoutMs}), [workflowOrigin]:origin.origin,actions};
}

// Calls ordinary observe and act execution inside the scheduler's existing
// workspace lane. Each write uses a newly published ref and current document.
export async function performWorkflow(service,ws,tab,params,op,fail) {
  const {receipt}=op;
  const origin=params[workflowOrigin];
  const check=()=>{
    if(op.cancel || op.controller.signal.aborted) fail('operation_cancelled');
    if(op.deadline !== undefined && Date.now() >= op.deadline) fail('run_timeout');
    service.requireControl(ws,params.controlGeneration);
    if(!ws.origins.has(origin) || URL.parse(tab.page.url())?.origin!==origin) fail('workflow_origin_changed');
  };
  receipt.state='running';
  receipt.phase='running';
  check();
  if(tab.documentId!==params.documentId) fail('stale_document');
  for(const step of params.actions) {
    const deadline=Date.now()+(step.timeoutMs ?? 0);
    let view,element;
    for(;;) {
      check();
      view=await service.observe(ws,tab,{locator:step.target});
      check();
      if(view.match.status==='ambiguous') fail('target_ambiguous');
      element=view.elements[0];
      if(step.kind!=='expect') {
        if(!element) fail('target_missing');
        break;
      }
      if(element && Object.entries(step.state).every(([k,v])=>element[k]===v)) break;
      if(Date.now()>=deadline) fail('wait_timeout');
      const remaining = Math.min(deadline-Date.now(), op.deadline === undefined ? Infinity : op.deadline-Date.now());
      if(remaining <= 0) fail('run_timeout');
      await new Promise(resolve=>setTimeout(resolve,Math.min(80,remaining)));
    }
    if(step.kind==='expect') {
      receipt.completedSteps++;
      receipt.phase='verifying';
      service.store.save(ws.owner,ws.id,op.digest,receipt);
      service.notify(ws);
      continue;
    }
    const {target,...action}=step;
    await perform(service,ws,tab,{documentId:view.documentId,controlGeneration:view.controlGeneration,
      actions:[{...action,ref:element.ref}]},op,{finalize:false});
    if(['cancelled','failed','outcome_unknown'].includes(receipt.state)) return;
  }
  receipt.state='completed';
  receipt.phase='completed';
}
