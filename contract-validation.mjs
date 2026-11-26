import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { tools } from './api-contract.mjs';

const validators = new Map();
const validator = new AjvJsonSchemaValidator();
const schemas = new Map(tools.map(tool => [tool.name,tool.inputSchema]));
// Older callers spread a returned page or workspace handle into a subsequent request.
// Strip only the known read-only handle fields before checking that request.
const viewFields = new Set(['agentName','name','mode','pages','controlGeneration','activity','blockedOrigins','pageId','origin','title','profile','profileId','profileAlias',
  'openedByOperationId','openerPageId','documentId','pendingDialogs']);

export function checkAgentRequest(method, params) {
  const schema = schemas.get(method);
  if (!schema) throw Object.assign(new Error('unknown_method'), {code:'unknown_method'});
  let check = validators.get(method);
  if (!check) {
    check = validator.getValidator(schema);
    validators.set(method,check);
  }
  const args = {...params};
  if (schema.properties.workspaceId) {
    for (const key of Object.keys(args))
      if (!Object.hasOwn(schema.properties,key) && viewFields.has(key)) delete args[key];
  }
  if (!check(args).valid) throw Object.assign(new Error('invalid_params'), {code:'invalid_params'});
  return args;
}
