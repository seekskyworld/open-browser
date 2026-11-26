import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { runTestHarness } from './test-harness.mjs';

const site = createServer((_req,res) => {
  res.setHeader('content-type','text/html');
  res.end('<button>Do action</button><p>PRIVATE_PAGE_123</p>');
});
site.listen(0,'127.0.0.1');
await once(site,'listening');
try {
  await runTestHarness({
    'diagnostic-export':async ({open,cli}) => {
      const {page,observe} = await open('http://127.0.0.1:'+site.address().port);
      const {documentId,controlGeneration} = await observe();
      // IDs are caller controlled and cannot be presumed safe for export.
      const operationId = 'PRIVATE_ACCOUNT_456', handle = {workspaceId:page.workspaceId,operationId};
      let receipt = await cli('act',{...page,documentId,controlGeneration,operationId,
        actions:[{kind:'wait',text:'PRIVATE_PASSWORD_789',timeoutMs:100}]});
      for (let attempt=0;['running','queued'].includes(receipt.state) && attempt<100;attempt++) {
        await new Promise(resolve=>setTimeout(resolve,20));
        receipt = await cli('getOperation',handle);
      }
      assert.equal(receipt.error,'wait_timeout');
      let report;
      try { report = await cli('diagnoseOperation',handle); }
      catch (e) { if (!String(e).includes('UNKNOWN_METHOD')) throw e; }
      if (report) {
        assert.equal(report.category,'timeout');
        assert.equal(report.dispatchRecorded,false);
        assert.equal(report.nextAction,'check_site_result');
        assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
      }
      return {dedicatedExport:!!report,receiptContainsCallerId:JSON.stringify(receipt).includes('PRIVATE_ACCOUNT'),
        markerInExport:report?JSON.stringify(report).includes('PRIVATE_'):null, nextAction:report?.nextAction};
    },
    'contract-boundaries':async ({cli}) => {
      const capabilities = await cli('capabilities');
      let created;
      try { created = await cli('createWorkspace',{name:'strict-check',extraOption:true}); }
      catch (e) { if (!String(e).includes('invalid_params')) throw e; }
      if (created) await cli('closeWorkspace',{workspaceId:created.workspaceId});
      const methods = capabilities.methods ?? [];
      if (capabilities.contractVersion) {
        assert.equal(created,undefined);
        assert.ok(methods.includes('diagnoseOperation'));
        assert.equal(capabilities.limits.actionsPerOperation,32);
      }
      return {unknownOptionCreatedWorkspace:!!created, discoverableMethods:methods.length,
        contractVersion:capabilities.contractVersion??null};
    }
  },1);
} finally { site.closeAllConnections(); await new Promise(resolve=>site.close(resolve)); }
