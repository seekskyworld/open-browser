// One capability source for server-side guards and the packaged desktop host.
// Browser-extension/worker.js mirrors the generated desktop list because MV3
// service workers cannot import the Node ESM runtime.
export const readCapabilities = Object.freeze([
  'getWorkspace', 'diagnoseOperation', 'getOperation', 'getRecoverySummary',
  'previewFinish', 'listOperations', 'listEvents', 'eventCursor', 'waitForEvent',
  'listDownloads', 'listOutputs', 'readOutput', 'observe', 'captureVisual',
]);

export const desktopCapabilities = Object.freeze([
  'offerCurrentTab', 'listUploads', 'grantUpload', 'revokeUpload', 'respondDialog',
  'listDownloads', 'cancelDownload', 'keepDownload', 'visualStatus',
  'diagnoseOperation', 'listWorkspaces', 'getWorkspace', 'takeControl',
  'returnToAgent', 'resolveCredential', 'grantOrigin', 'finishWorkspace',
  'listOperations', 'listEvents', 'eventCursor', 'listAgentHistory', 'closeWorkspace', 'showPage',
]);

export const capabilityProfiles = Object.freeze({
  read: readCapabilities,
  desktop: desktopCapabilities,
});
