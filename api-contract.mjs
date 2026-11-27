import { desktopCapabilities, readCapabilities } from './capability-matrix.mjs';

const id = { type: 'string', minLength: 1 };
function object(properties, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false };
}
const workspace = { workspaceId: id };
const page = { ...workspace, pageId: id };
const operation = { ...workspace, operationId: id };
const point={x:{type:'number'},y:{type:'number'}};
const region=object({...point,width:{type:'integer',minimum:1},height:{type:'integer',minimum:1}});
const spatialAction={oneOf:[
  object({type:{enum:['click','hover','tap']},...point}),
  object({type:{const:'drag'},...point,toX:{type:'number'},toY:{type:'number'}}),
  object({type:{const:'scroll'},...point,deltaX:{type:'number'},deltaY:{type:'number'}}),
  object({type:{const:'key'},...point,keys:{type:'array',minItems:1,maxItems:3,items:id}}),
  object({type:{const:'text'},...point,text:{type:'string',minLength:1,maxLength:2048}}),
]};
const action = {
  oneOf: [
    object({kind:{const:'upload'},fileId:id,ref:id}),
    object({kind:{const:'spatial'},frameId:id,action:spatialAction}),
    object({ kind: { const: 'wait' }, text: id, timeoutMs:{type:'integer',minimum:1,maximum:10000} }, ['kind','text']),
    object({kind:{const:'wait'},url:{type:'string',format:'uri'},timeoutMs:{type:'integer',minimum:1,maximum:10000}},['kind','url']),
    object({kind:{const:'wait'},absent:object({role:id,name:id}),timeoutMs:{type:'integer',minimum:1,maximum:10000}},['kind','absent']),
    object({kind:{const:'wait'},navigation:{const:'commit'},timeoutMs:{type:'integer',minimum:1,maximum:10000}},['kind','navigation']),
    object({kind:{const:'wait'},element:object({role:id,name:id,checked:{enum:[true,false,'mixed']},pressed:{enum:[true,false,'mixed']},expanded:{type:'boolean'},selected:{type:'boolean'}},['role','name']),timeoutMs:{type:'integer',minimum:1,maximum:10000}},['kind','element']),
    object({kind:{const:'setChecked'},ref:id,checked:{type:'boolean'}}),
    object({ kind: { const: 'select' }, ref:id, value:{type:'string'} }),
    object({ kind: { const: 'click' }, ref: id }),
    object({ kind: { const: 'doubleClick' }, ref: id }),
    object({ kind: { const: 'hover' }, ref: id }),
    object({ kind: { const: 'press' }, ref: id, key: id }),
    object({ kind: { const: 'scroll' }, ref: id, deltaX:{type:'number'}, deltaY:{type:'number'} }, ['kind','ref','deltaY']),
    object({ kind: { const: 'drag' }, ref: id, toRef: id }),
    object({ kind: { const: 'fill' }, ref: id, value: { type: 'string' } }),
    object({ kind: { const: 'fillCredential' }, ref: id, credentialRef: id }),
  ],
};
const history = {...workspace, after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}};
const semanticTarget=object({role:id,name:id,within:object({role:id,name:id})},['role','name']);
const expectedState=object({checked:{enum:[true,false,'mixed']},pressed:{enum:[true,false,'mixed']},
  expanded:{type:'boolean'},selected:{type:'boolean'}},[]);
const workflowStep={oneOf:[
  object({kind:{const:'click'},target:semanticTarget}),
  object({kind:{enum:['upload','fillCredential']},target:semanticTarget,binding:{type:'string',maxLength:80,pattern:'^[a-zA-Z][a-zA-Z0-9_-]*$'}}),
  object({kind:{const:'expect'},target:semanticTarget,state:expectedState,
    timeoutMs:{type:'integer',minimum:1,maximum:10000}},['kind','target']),
]};
const definitions = {
  runWorkflow:['Run a local origin-bound semantic workflow and poll its operation receipt. Bind only granted file IDs or credential references. The optional timeout is a wall-clock budget shared by queueing and execution.',{
    ...page,operationId:id,documentId:id,controlGeneration:id,
    timeoutMs:{type:'integer',minimum:1,maximum:60000},
    workflow:object({version:{const:1},origin:{type:'string',format:'uri'},steps:{type:'array',minItems:1,maxItems:32,items:workflowStep}}),
    bindings:{type:'object',maxProperties:32,additionalProperties:{type:'string',minLength:1,maxLength:160}},
  },['workspaceId','pageId','documentId','controlGeneration','operationId','workflow']],

  capabilities: ['Discover service version, enabled inputs, limits and privacy mode before using optional features.',{}],
  captureVisual: ['Capture approved masked viewport pixels. Coordinates use viewport CSS pixels.',{...page,region,ref:id},Object.keys(page)],
  listWorkspaces: ['List the workspaces available to this agent.', {}],
  createWorkspace: ['Create a browser workspace. Every task must provide a clear non-empty name. Each subagent should pass its own display name in agentName.', {
    profileId:{type:'string',pattern:'^[a-z0-9][a-z0-9_-]{0,47}$'},
    name: { type: 'string', minLength: 1, maxLength: 120 },
    agentName: { type: 'string', maxLength: 80 },
    resourceOrigins: { type: 'array',maxItems:32,items:{type:'string',format:'uri'} },
    allowedOrigins: { type: 'array', maxItems: 32, items: { type: 'string', format: 'uri' } },
  }, ['name']],
  open: ['Create a named workspace for one explicit URL and open its first page in one call.', {
    profileId:{type:'string',pattern:'^[a-z0-9][a-z0-9_-]{0,47}$'},
    name: { type: 'string', minLength: 1, maxLength: 120 },
    agentName: { type: 'string', maxLength: 80 },
    url: { type: 'string', format: 'uri' },
    resourceOrigins: { type: 'array',maxItems:32,items:{type:'string',format:'uri'} },
    allowedOrigins: { type: 'array', maxItems:32, items:{type:'string',format:'uri'} },
  }, ['url','name']],
  grantOrigin: ['Grant one origin already recorded as blocked for this workspace. Use only after checking blockedOrigins and obtaining workspace control.', {
    ...workspace, controlGeneration: id, origin: { type:'string', format:'uri' },
    scope: { enum:['navigation','resource'], type:'string' },
  }, ['workspaceId','controlGeneration','origin','scope']],
  canvasSnapshot: ['Read visible React Flow nodes and edges, chat turns and download labels. Compare snapshotVersion after an action. Unsupported markup is reported explicitly.',page],
  adoptCurrentTab: ['Redeem the two-minute token issued by the user for this empty named workspace. The original tab stays open at finish.', {...workspace,adoptionToken:{type:'string',pattern:'^[0-9a-f]{64}$'}}],
  reattachPage: ['Refresh the exact managed page after the user returns control. Returns a fresh observation. Set waitMs to wait for human control to return.',{...page,waitMs:{type:'integer',minimum:1,maximum:30000}},Object.keys(page)],
  previewFinish: ['Preview which pages will stay open and which will close. Pass previewId to finishWorkspace to require this plan.',{...workspace,keepPageIds:{type:'array',uniqueItems:true,items:id}}],
  getWorkspace: ['Read workspace control, page availability and extension synchronization. Supply profileId to verify the expected profile.', {...workspace,profileId:id},['workspaceId']],
  openPage: ['Open a page in the workspace.', { ...workspace, url: { type: 'string', format: 'uri' } }],
  observe: ['Read visible controls. Continue a truncated observation with nextCursor or filter by name or viewport region. After stale_ref, stale_document or user handoff, observe again before acting.', {
    ...page, includeFrames:{type:'boolean'}, frameControls:{type:'boolean'},
    locator:object({role:id,name:id,within:object({role:id,name:id})},['role','name']),
    cursor:id, limit:{type:'integer',minimum:1,maximum:180}, name:id, region,
  }, Object.keys(page)],
  observeAndAct: ['Observe the current page and submit an ordered action batch through one service request. The service binds the actions to the returned document and control generation before queueing them.', {
    ...page, includeFrames:{type:'boolean'}, frameControls:{type:'boolean'},
    locator:object({role:id,name:id,within:object({role:id,name:id})},['role','name']),
    cursor:id, limit:{type:'integer',minimum:1,maximum:180}, name:id, region,
    operationId:id, timeoutMs:{type:'integer',minimum:1,maximum:60000},
    observeAfter:{enum:['full','delta']},
    actions:{type:'array',minItems:1,maxItems:32,items:action},
  }, ['workspaceId','pageId','operationId','actions']],
  act: ['Submit ordered actions for the observed document and control generation. Use fillCredential for login secrets. Supply a unique operationId. The optional timeout is a wall-clock budget shared by queueing and execution. After a timeout or outcome_unknown, query the receipt and verify the site before retrying.', {
    ...page, operationId: id, documentId: id, controlGeneration: id,
    timeoutMs:{type:'integer',minimum:1,maximum:60000},
    observeAfter:{enum:['full','delta']},
    actions: { type: 'array', minItems: 1, maxItems:32, items: action },
  }, ['workspaceId','pageId','operationId','documentId','controlGeneration','actions']],
  respondDialog:['Respond once to a pending JavaScript dialog in the controlled page.',{...page,dialogId:id,controlGeneration:id,accept:{type:'boolean'},text:{type:'string',maxLength:2048}},[...Object.keys(page),'dialogId','controlGeneration','accept']],
  listUploads:['List live desktop file grants for this workspace.',workspace],
  listDownloads:['List downloads for this workspace and their current state.',workspace],
  listOutputs:['List locally delivered output manifests for this workspace.',workspace],
  readOutput:['Read one locally delivered output in bounded base64 chunks. Use nextOffset to continue.',{...workspace,outputId:id,partName:{type:'string',maxLength:180},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:65536}},['workspaceId','outputId']],
  cancelDownload:['Cancel a download belonging to this workspace.',{...workspace,downloadId:id}],
  eventCursor:['Get the current workspace event cursor before triggering an action.',workspace],
  waitForEvent:['Wait for a matching page event. Reuse the same cursor to read it after reconnecting.',
    {...page,kind:{enum:['dialog','download','popup']},after:{type:'integer',minimum:0},operationId:id,
      timeoutMs:{type:'integer',minimum:1,maximum:10000}},[...Object.keys(page),'kind','after']],
  listEvents:['Poll redacted changes since a sequence number.',history,['workspaceId']],
  getRecoverySummary:['Read task recovery steps, delivered objects and page availability. Observe or verify before resuming.',{...history,objectsAfter:{type:'integer',minimum:0}},['workspaceId']],
  listOperations:['Read redacted receipt history.',history,['workspaceId']],
  finishWorkspace:['Call when the overall task is complete, before reporting success. Keep selected result tabs as ordinary tabs and remove the task group. Use an empty list when there are no results to keep.',{...operation,keepPageIds:{type:'array',uniqueItems:true,items:id},previewId:id},['workspaceId','operationId','keepPageIds']],
  diagnoseOperation: ['Preview a redacted diagnostic with the next safe action. Use it after a timeout, disconnect or outcome_unknown.', operation],
  getOperation: ['Read an operation receipt, including its completed step count.', operation],
  cancelOperation: ['Cancel the remaining steps of an operation.', operation],
  handOff: ['Hand control of the workspace to its user.', workspace],
  closeWorkspace: ['Close the workspace and its managed pages.', workspace],
};
export const tools = Object.freeze(Object.entries(definitions).map(([name, [description, fields, required]]) =>
  ({ name, description, inputSchema:object(fields, required) })));
export const agentMethods = Object.freeze(tools.map(tool => tool.name));
export const capabilityProfiles = Object.freeze({
  agent: agentMethods,
  read: readCapabilities,
  desktop: desktopCapabilities,
});
export const limits = Object.freeze({requestBytes:256*1024, responseBytes:8*1024*1024, clientTimeoutMs:60000, runTimeoutMs:60000,
  actionsPerOperation:32, waitMs:10000, observationControls:180, uploadFileBytes:8*1024*1024, visualPngBytes:3*1024*1024});
