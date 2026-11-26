// Isolated experiment. Applied by the benchmark service child process only.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const implementation = new URL('../managed-popup.mjs',import.meta.url).href;
registerHooks({load(url,context,next) {
  const result=next(url,context);
  if(url!==implementation)return result;
  const original=String(result.source);
  const anchor="      if (!current || !url ||";
  assert.ok(original.includes(anchor));
  const prototype=`      if(current && !url) {
        const token=current;
        return {set location(next) {
          try { request(token,new URL(String(next),document.baseURI).href); } catch {}
        }};
      }
`;
  return {...result,source:original.replace(anchor,prototype+anchor)};
}});
