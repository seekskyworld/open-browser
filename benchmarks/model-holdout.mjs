// Only synthetic form controls from the local fixture are sent to a local model.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runTestHarness } from './test-harness.mjs';

const model = process.env.OPEN_BROWSER_EVAL_MODEL;
const port = Number(process.env.OPEN_BROWSER_EVAL_MODEL_PORT);
if (!model || !Number.isInteger(port) || port < 1 || port > 65535)
  throw Error('Set OPEN_BROWSER_EVAL_MODEL and OPEN_BROWSER_EVAL_MODEL_PORT for your local model.');
const endpoint = 'http://127.0.0.1:' + port;
const settings = {model, temperature:0, seed:41, chat_template_kwargs:{enable_thinking:false}, reasoning_budget:0, max_tokens:100, stream:false,
  response_format:{type:'json_object'}};
const targetStates = process.argv.includes('--target-states');
const records = new Map();
const site = createServer(async (req,res) => {
  const form = records.get(req.url);
  if (!form) return res.writeHead(404).end();
  res.setHeader('content-type','text/html; charset=utf-8');
  if (req.method === 'POST') {
    let body = '';
    for await (const part of req) body += part;
    form.writes.push(new URLSearchParams(body));
    return res.end('<p>Saved</p>');
  }
  res.end('<form method="post"><label><input type="checkbox" name="weekly" '+(form.initial?'checked':'')+'>Weekly digest</label>'+
    '<label><input type="checkbox" name="invoices" checked>Invoice receipts</label><button>Save</button></form>');
});
async function choose(elements, wanted) {
  const observed = elements.map(({ref,...item}, index) => ({...item,index}));
  const question = 'Set Weekly digest to '+(wanted?'enabled':'disabled')+
    ', preserve Invoice receipts, and save exactly once. '+(targetStates ?
      'Return JSON {"actions":[...]}. Available actions: {"kind":"setChecked","index":integer,"checked":boolean} or {"kind":"click","index":integer}. If unsure, return {"actions":[]}. Controls: ' :
      'Return JSON {"clicks":[...]} containing the observed indices in click order. If the task cannot be determined, return {"clicks":[]}. Controls: ')+JSON.stringify(observed);
  const response = await fetch(endpoint+'/v1/chat/completions',{method:'POST',redirect:'error',
    signal:AbortSignal.timeout(60000),headers:{'content-type':'application/json'},
    body:JSON.stringify({...settings,messages:[{role:'user',content:question}]})});
  if (!response.ok) throw Error('model HTTP '+response.status);
  const {choices} = await response.json();
  const result = JSON.parse(choices[0].message.content);
  const selected = targetStates ? result.actions : result.clicks?.map(index=>({kind:'click',index}));
  if (!Array.isArray(selected) || selected.length>4) return [];
  const actions = [];
  for (const item of selected) {
    const ref = Number.isInteger(item?.index) && elements[item.index]?.ref;
    if (!ref) return [];
    if (item.kind === 'click') actions.push({kind:'click',ref});
    else if (item.kind === 'setChecked' && typeof item.checked === 'boolean')
      actions.push({kind:'setChecked',ref,checked:item.checked});
    else return [];
  }
  return actions;
}
const cases = {};
const scores = [];
for (const initial of [true,false]) for (const wanted of [true,false]) {
  const name = 'digest-'+Number(initial)+'-to-'+Number(wanted);
  cases[name] = async ({open,cli}) => {
    const key = '/'+randomUUID();
    const form = {initial,writes:[]};
    records.set(key,form);
    const started = performance.now();
    let calls = 0, failure = null;
    const origin = 'http://127.0.0.1:'+site.address().port;
    try {
      const session = await open(origin+key);
      calls += 2;
      const observed = await session.observe();
      calls++;
      let actions;
      try { actions = await choose(observed.elements,wanted); }
      catch { failure = 'model_response'; }
      if (!failure && !actions.length) failure = 'model_choice';
      if (!failure) {
        const op = {operationId:randomUUID(), ...session.page, documentId:observed.documentId,
          controlGeneration:observed.controlGeneration, actions};
        let receipt = await cli('act',op);
        calls++;
        const deadline = Date.now()+12000;
        while (['queued','running'].includes(receipt.state) && Date.now()<deadline) {
          await new Promise(resolve=>setTimeout(resolve,25));
          receipt = await cli('getOperation',{workspaceId:op.workspaceId,operationId:op.operationId});
          calls++;
        }
        if (receipt.state !== 'completed') failure = 'browser_operation';
      }
      const saved = form.writes[0];
      const correct = form.writes.length===1 && saved.has('weekly')===wanted && saved.has('invoices');
      const score = {model,seed:settings.seed,success:correct && !failure,failure:failure || (correct?null:'model_choice'),
        cliCalls:calls,duplicateWrites:Math.max(0,form.writes.length-1),humanInterventions:0,
        wallMs:Math.round(performance.now()-started)};
      scores.push(score);
      return score;
    } finally { records.delete(key); }
  };
}
site.listen(0,'127.0.0.1');
await once(site,'listening');
try { await runTestHarness(cases); }
finally { site.closeAllConnections(); await new Promise(resolve=>site.close(resolve)); }

const times = scores.map(score=>score.wallMs).sort((a,b)=>a-b);
console.log(JSON.stringify({model,total:scores.length,successes:scores.filter(score=>score.success).length,
  p95Ms:times[Math.ceil(times.length*.95)-1],cliCalls:scores.reduce((n,s)=>n+s.cliCalls,0),
  duplicateWrites:scores.reduce((n,s)=>n+s.duplicateWrites,0)}));
