/** v0.1 SDK and host contracts. All IDs are opaque and scoped by the service. */
export interface PageHandle {
  workspaceId: string;
  pageId: string;
}

export interface WorkspaceInfo {
  pendingDialogs?: Array<{dialogId:string;pageId:string;documentId:string;origin:string;operationId:string;type:'alert'|'confirm'|'prompt';message:string}>;
  workspaceId: string;
  profileId: string;
  name: string;
  /** Creator's display label, independent of access control. */
  agentName: string;
  mode: 'agent' | 'transferring' | 'human';
  controlGeneration: string;
  scope:'workspace'|'single_tab';
  pageAvailability:'managed'|'closed'|'unregistered'|'sync_pending';
  nextAction:'wait_for_sync'|'reattachPage'|'request_tab_selection'|'wait_for_agent_control';
  accountAlias?:string;
  pages: ReadonlyArray<PageHandle & { ownership:'user'|'agent'; syncState:'synced'|'not_required'|'sync_pending'; syncRevision:number; lastSyncedAt:number|null; documentId:string; origin: string; title: string; openerPageId?:string; openedByOperationId?:string }>;
  activity: WorkspaceActivity;
  blockedOrigins?: Array<{origin:string; scope:'resource'|'navigation'; reason:string; resourceType:string}>;
}

export interface WorkspaceOperation {
  pageId?: string;
  kind: 'openPage' | 'observe' | 'act' | 'captureVisual' | 'adoptCurrentTab' | 'canvasSnapshot';
  state: OperationReceipt['state'];
  completedSteps: number;
  totalSteps: number;
  dispatchState?: 'waiting'|'dispatched';
  stepKind?: PageAction['kind'];
  phase?: 'queued'|'running'|'actionability'|'dispatching'|'waiting'|'verifying'|'completed'|'cancelled'|'failed'|'outcome_unknown';
  fillOutcome?: 'exact'|'equivalent'|'transformed'|'appended'|'unchanged';
  error?: string;
  navigation?: 'not_committed'|'document_committed'|'same_document';
}

export interface WorkspaceActivity {
  phase: 'idle' | 'needs_credential' | 'needs_human_verification' | OperationReceipt['state'];
  queued: number;
  running: WorkspaceOperation[];
  current: WorkspaceOperation | null;
  recent: WorkspaceOperation | null;
  needsCredential: boolean;
  needsHumanVerification: boolean;
  securityChallenge?: { provider: 'cloudflare' | string; origin: string; status: number; detectedAt: number };
  /** Only getWorkspace returns request metadata. No credential values are returned. */
  credentialRequest: {
    documentId: string;
    controlGeneration: string;
    origin: string;
    credentialRef: string;
    pageId: string;
    operationId: string;
  } | null;
}

export interface CreateWorkspaceOptions {
  profileId?: string;
  /** Required task name shown in the Agent console and browser tab group. */
  name: string;
  /** Creator display name (up to 80 Unicode code points). Each subagent should supply its own. */
  agentName?: string;
  /** With no explicit allowlist, the first page fixes the allowed origin. */
  allowedOrigins?: readonly string[];
  resourceOrigins?: readonly string[];
}

export interface OpenOptions extends CreateWorkspaceOptions {
  /** Explicit target URL. The convenience entry uses normal page networking for faithful rendering. */
  url: string;
}

export interface ObserveOptions {
  locator?: {role:string; name:string; within?: {role:string;name:string}};
  includeFrames?: boolean;
  frameControls?: boolean;
  limit?: number;
  name?: string;
  region?: VisualRect;
  cursor?: string;
}
export interface ObservedElement {
  ref?: string;
  role: string;
  name: string;
  checked?: boolean|'mixed';
  pressed?: boolean|'mixed';
  selected?: boolean;
  expanded?: boolean;
  options?: Array<{label:string; value:string}>;
}
export interface WorkspaceDownload extends PageHandle {
  downloadId: string;
  filename: string;
  state: 'receiving'|'ready'|'cancelled'|'failed'|'kept';
}
export interface OutputManifest {
  id: string;
  expiresAt: number;
  parts: ReadonlyArray<{name:string;mimeType:string;bytes:number}>;
}
export interface OutputChunk {
  outputId: string;
  part: {name:string;mimeType:string;bytes:number};
  offset: number;
  bytes: number;
  nextOffset: number|null;
  done: boolean;
  data: string;
}
export interface PageObservation extends PageHandle {
  /** Unique identifier for this observation payload. */
  observationId: string;
  documentId: string;
  /** Changes whenever workspace control changes hands, even without navigation. */
  controlGeneration: string;
  text: string;
  /** Read-only delegates receive role/name without actionable refs. */
  elements: ReadonlyArray<ObservedElement>;
  foreground?: {role:string;name:string;bounds:VisualRect};
  match?: {status:'unique'|'ambiguous'|'missing';count:number;candidates:Array<{role:string;name:string;within?:{role:string;name:string}}>};
  truncated?: boolean;
  nextCursor?: string;
  frames?: Array<{origin:string; text:string; frameId?:string; documentId?:string; elements?:ObservedElement[]}>;
  blockedRequests?: Array<{origin:string; resourceType:string; reason:string}>;
}

export interface VisualRect {x:number; y:number; width:number; height:number}
export type SpatialAction = {x:number;y:number} & (
  {type:'click'|'hover'|'tap'} | {type:'drag';toX:number;toY:number} |
  {type:'scroll';deltaX:number;deltaY:number} | {type:'key';keys:string[]} | {type:'text';text:string});
export interface VisualFrame extends PageHandle {
  frameId:string;documentId:string;controlGeneration:string;origin:string;mimeType:'image/png';data:string;
  clip:VisualRect;viewport:{width:number;height:number};pixelWidth:number;pixelHeight:number;scale:number;zoom:number;deviceScaleFactor:number;
}
export type PageAction =
  | {kind:'upload';ref:string;fileId:string}
  | {kind:'spatial';frameId:string;action:SpatialAction}
  | { kind:'setChecked'; ref:string; checked:boolean }
  | { kind: 'select'; ref:string; value:string }
  | ({ kind:'wait'; timeoutMs?:number } & ({text:string}|{url:string}|{element:Pick<ObservedElement,'role'|'name'|'checked'|'pressed'|'expanded'|'selected'>}|{absent:{role:string;name:string}}|{navigation:'commit'}))
  | { kind: 'click'; ref: string }
  | { kind: 'doubleClick'|'hover'; ref: string }
  | { kind: 'press'; ref: string; key: string }
  | { kind: 'scroll'; ref: string; deltaX?: number; deltaY: number }
  | { kind: 'drag'; ref: string; toRef: string }
  | { kind: 'fill'; ref: string; value: string }
  /** The host resolves the credential for the authorized workspace and origin. */
  | { kind: 'fillCredential'; ref: string; credentialRef: string };

export type WorkflowTarget = {role:string;name:string;within?:{role:string;name:string}};
export type WorkflowStep =
  | {kind:'click';target:WorkflowTarget}
  | {kind:'upload'|'fillCredential';target:WorkflowTarget;binding:string}
  | {kind:'expect';target:WorkflowTarget;state?:Pick<ObservedElement,'checked'|'pressed'|'expanded'|'selected'>;timeoutMs?:number};
export interface WorkflowRequest {
  documentId:string;
  controlGeneration:string;
  operationId:string;
  workflow:{version:1;origin:string;steps:readonly WorkflowStep[]};
  bindings?:Record<string,string>;
  /** Wall-clock budget shared by queueing and execution, up to 60 seconds. */
  timeoutMs?: number;
}

export interface OperationReceipt {
  pageId?:string;
  operationId: string;
  state: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'outcome_unknown';
  /** Durable execution phase for recovery and progress display. */
  phase?: 'queued'|'running'|'actionability'|'dispatching'|'waiting'|'verifying'|'completed'|'cancelled'|'failed'|'outcome_unknown';
  totalSteps?: number;
  stepKind?: PageAction['kind'];
  completedSteps: number;
  error?: string;
  observation?: PageObservation;
  delta?: {changed?: ObservedElement[]; textChanged:boolean; text?:string; added:Array<{role:string;name:string}>; removed:Array<{role:string;name:string}>};
  dialogIds?: string[];
  openedPageIds?: string[];
  keptPageIds?: string[];
  closedPageIds?: string[];
  /** Included with credential_required to identify which reference to bind. */
  credentialRef?: string;
}

/** CLI and MCP call this surface through the same SDK. */
export interface OpenBrowserV1 {
  capabilities(): Promise<{version:number;contractVersion?:number;methods?:readonly string[];limits?:Readonly<Record<string,number>>;privacy?:{
    profile:'strict'|'compatibility'|string;
    telemetry:'disabled';
    chromiumServices:'reduced'|'compatibility';
    taskNetwork:'explicit-origins';
    diagnostics:'redacted';
    credentials:'memory-scoped';
  };visual:{enabled:boolean;actions:readonly string[]}}>;
  captureVisual(page:PageHandle,options?:{region?:VisualRect;ref?:string}):Promise<VisualFrame>;
  createWorkspace(options?: CreateWorkspaceOptions): Promise<WorkspaceInfo>;
  open(options: OpenOptions): Promise<PageHandle>;
  /** SDK convenience. Opens one URL and observes it with fresh document metadata. */
  openAndObserve(options?: OpenOptions, observeOptions?: ObserveOptions): Promise<PageHandle & {observation: PageObservation}>;
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  getWorkspace(workspaceId: string): Promise<WorkspaceInfo>;
  openPage(workspaceId: string, url: string): Promise<PageHandle>;
  adoptCurrentTab(workspaceId:string, adoptionToken:string):Promise<PageHandle>;
  reattachPage(page:PageHandle, options?:{waitMs?:number}):Promise<PageObservation>;
  previewFinish(workspaceId:string, keepPageIds?:string[]):Promise<{previewId:string; keptPageIds:string[]; closedPageIds:string[]}>;
  canvasSnapshot(page:PageHandle):Promise<PageHandle & {documentId:string; controlGeneration:string; snapshotVersion:string;
    adapter:'react-flow'|'chat'|'unsupported'; nodes:Array<{id:string; label:string; selected:boolean}>;
    edges:Array<{id:string; label:string; selected:boolean; source?:string; target?:string}>; messages:Array<{role:string; text:string}>;
    attachments:Array<{label:string}>; truncated:boolean}>;
  observe(page: PageHandle & ObserveOptions): Promise<PageObservation>;
  /** SDK convenience. Observes and queues an action batch through one service request. */
  observeAndAct(page: PageHandle & ObserveOptions, request: {actions: readonly PageAction[];operationId?:string;observeAfter?:'full'|'delta';timeoutMs?:number}): Promise<{observation:PageObservation;receipt:OperationReceipt}>;
  runWorkflow(page:PageHandle,request:WorkflowRequest):Promise<OperationReceipt>;
  act(page: PageHandle, request: {
    operationId: string;
    documentId: string;
    controlGeneration: string;
    actions: readonly PageAction[];
    observeAfter?: 'full'|'delta';
    /** Wall-clock budget shared by queueing and execution, up to 60 seconds. */
    timeoutMs?: number;
  }): Promise<OperationReceipt>;
  /** SDK convenience. Observes immediately before acting and generates an operation ID when omitted. */
  actAfterObserve(page: PageHandle, request: {actions: readonly PageAction[];operationId?:string;observeAfter?:'full'|'delta';timeoutMs?:number}): Promise<{observation:PageObservation;receipt:OperationReceipt}>;
  diagnoseOperation(workspaceId:string,operationId:string):Promise<{version:1;state:string;phase?:OperationReceipt['phase'];totalSteps?:number;completedSteps:number;dispatchRecorded:boolean;category:string;nextAction:string}>;
  getOperation(workspaceId: string, operationId: string): Promise<OperationReceipt>;
  finishWorkspace(workspaceId:string, keepPageIds:string[], operationId:string, previewId?:string): Promise<OperationReceipt>;
  /** SDK convenience. Generates a fresh idempotency key for finishing a workspace. */
  finish(workspaceId:string, keepPageIds?:string[]): Promise<OperationReceipt>;
  respondDialog(page:PageHandle, response:{controlGeneration:string;dialogId:string;accept:boolean;text?:string}):Promise<{dialogId:string;accepted:boolean}>;
  listUploads(workspaceId:string):Promise<Array<{fileId:string;pageId:string;documentId:string;controlGeneration:string;origin:string;name:string;size:number;expiresAt:number}>>;
  listDownloads(workspaceId:string): Promise<WorkspaceDownload[]>;
  listOutputs(workspaceId:string): Promise<OutputManifest[]>;
  readOutput(workspaceId:string, outputId:string, options?:{partName?:string;offset?:number;limit?:number}): Promise<OutputChunk>;
  cancelDownload(workspaceId:string,downloadId:string): Promise<WorkspaceDownload>;
  getRecoverySummary(workspaceId:string, options?:{after?:number;objectsAfter?:number;limit?:number}): Promise<{
    workspaceId:string; mode:WorkspaceInfo['mode']|'unavailable'; pages:Array<{pageId:string;next:'observe'|'handle_unavailable'; lastDisposition?:'released'|'closed'; pageAvailability:'managed'|'unregistered'|'closed'; nextAction:string}>;
    deliveries:Array<{downloadId:string}>; outputs:Array<{outputId:string}>; operations:Array<OperationReceipt & {next:'verify_site'|'poll'|'already_completed'|'inspect_receipt'}>;
    nextCursor:number|null; nextObjectCursor:number|null;
  }>;
  listOperations(workspaceId:string, options?:{after?:number;limit?:number}): Promise<{operations:OperationReceipt[];nextCursor:number|null}>;
  eventCursor(workspaceId:string):Promise<{nextCursor:number}>;
  waitForEvent(page:PageHandle, options:{after:number;kind:'dialog'|'download'|'popup';operationId?:string;timeoutMs?:number}):
    Promise<{event:null|{sequence:number;kind:string;state:string;pageId:string;resourceId:string;operationId?:string};nextCursor:number}>;
  listEvents(workspaceId:string, options?:{after?:number;limit?:number}): Promise<{
    events:Array<{sequence:number;kind:string;state:string;actorId?:string;operationId?:string;completedSteps?:number;pixelWidth?:number;pixelHeight?:number}>;
    nextCursor:number;
  }>;
  cancelOperation(workspaceId: string, operationId: string): Promise<OperationReceipt>;
  /** Optional transfer of control. Automatic login does not require handoff. */
  handOff(workspaceId: string): Promise<WorkspaceInfo>;
  closeWorkspace(workspaceId: string): Promise<{ workspaceId: string; closed: true }>;
}

/** Trusted host requests use the service's flat params objects. */
export interface OpenBrowserHostV1 {
  grantUpload(params:PageHandle & {origin:string;documentId:string;controlGeneration:string;name:string;mimeType?:string;data:string}):Promise<{fileId:string}>;
  revokeUpload(params:{workspaceId:string;fileId:string}):Promise<{revoked:true}>;
  respondDialog(params:PageHandle & {controlGeneration:string;dialogId:string;accept:boolean;text?:string}):Promise<{dialogId:string;accepted:boolean}>;
  keepDownload(params:{workspaceId:string;downloadId:string}):Promise<{download:WorkspaceDownload;path:string;output:OutputManifest}>;
  pageLocation(page: PageHandle): Promise<{ url: string; canGoBack: boolean; canGoForward: boolean }>;
  pageNavigate(params: PageHandle & ({ action: 'go'; url: string } | { action: 'back' | 'forward' | 'reload' })):
    ReturnType<OpenBrowserHostV1['pageLocation']>;
  pageNew(params: { workspaceId: string; url: string }): Promise<PageHandle>;
  pageFrame(params: PageHandle & { width?: number; height?: number }): Promise<{
    data: string; width: number; height: number; documentId: string; controlGeneration: string; title: string;
  }>;
  pageInput(params: PageHandle & { documentId: string; controlGeneration: string; event:
    | { type: 'mouseDown' | 'mouseUp' | 'mouseMove'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number }
    | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
    | { type: 'keyDown' | 'keyUp'; key: string }
    | { type: 'text'; text: string }
  }): Promise<{ accepted: true }>;
  closePage(page: PageHandle): Promise<PageHandle & { closed: true }>;
  previewPage(page: PageHandle): Promise<Omit<PageObservation, 'elements'>>;
  showPage(page: PageHandle): Promise<PageHandle>;
  takeControl(params: { workspaceId: string; pageId?: string; controlGeneration?: string }): Promise<WorkspaceInfo>;
  returnToAgent(params: { workspaceId: string; controlGeneration?: string }): Promise<WorkspaceInfo>;
  grantOrigin(params:{workspaceId:string;controlGeneration:string;origin:string;scope:'resource'|'navigation'}):Promise<unknown>;
  resolveCredential(params:PageHandle & {documentId:string;controlGeneration:string;operationId:string;origin:string;credentialRef:string;value:string}):Promise<{credentialRef:string;saved:true}>;
  setCredential(params: {
    workspaceId: string;
    origin: string;
    credentialRef: string;
    value: string;
  }): Promise<{ credentialRef: string; saved: true }>;
}
