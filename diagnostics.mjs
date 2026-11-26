// Export only categories from this table. IDs, URLs, page text and errors can contain user input.
const advice = new Map([
  ['target_obscured',['obscured','observe_foreground']],
  ['timeout',['timeout','check_site_result']],
  ['wait_timeout',['timeout','check_site_result']],
  ['workspace_under_user_control',['control_changed','wait_for_user']],
  ['stale_control',['control_changed','observe_after_return']],
  ['operation_cancelled',['cancelled','inspect_progress']],
  ['credential_required',['credential','bind_credential']],
  ['inspect_before_retry',['uncertain','check_site_result']],
  ['run_timeout',['budget','inspect_progress']],
  ['stale_ref',['stale_target','observe_again']],
  ['stale_document',['navigation','observe_again']],
]);
const states = new Set(['queued','running','failed','completed','cancelled','outcome_unknown']);
export function operationDiagnostic(receipt, dispatched) {
  const state = states.has(receipt.state) ? receipt.state : 'unknown';
  let next = advice.get(receipt.error);
  if (state === 'outcome_unknown') next = ['uncertain','check_site_result'];
  if (!next) {
    if (state === 'completed') next = ['completed','verify_site_result'];
    else if (state === 'running' || state === 'queued') next = ['pending','poll_receipt'];
    else next = ['interrupted','inspect_progress'];
  }
  return {version:1, state, ...(receipt.phase && {phase:receipt.phase}), completedSteps:receipt.completedSteps,
    ...(receipt.totalSteps !== undefined && {totalSteps:receipt.totalSteps}), dispatchRecorded:dispatched,
    category:next[0], nextAction:next[1]};
}
