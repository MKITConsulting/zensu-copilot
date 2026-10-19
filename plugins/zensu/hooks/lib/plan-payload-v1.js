'use strict';

// Copilot approval is an exact human-response event correlated by the native
// approval reader. The receipt contains the approved bytes. Model-authored
// tool arguments, prose responses and paths are never alternative authorities.
const PLAN_FILE_MAX_BYTES = 4 * 1024 * 1024;
const REASONS = Object.freeze({
  MISSING: 'INVALID_PLAN_PAYLOAD', FIELD_TYPE: 'PLAN_PAYLOAD_FIELD_TYPE_REJECTED',
  UNREADABLE: 'PLAN_FILE_UNREADABLE', PATH_REJECTED: 'PLAN_FILE_PATH_REJECTED',
  NOT_REGULAR: 'PLAN_FILE_NOT_REGULAR', EMPTY: 'PLAN_FILE_EMPTY',
  TOO_LARGE: 'PLAN_FILE_TOO_LARGE', SYMLINK: 'PLAN_FILE_SYMLINK_REJECTED',
});
function resolveApprovedPlan(payload) {
  const receipt = payload && payload.toolResult;
  const source = 'native-human-plan-response';
  const refuse = reason => ({ ok: false, reason, source });
  if (payload?.planApproved !== true || !receipt || receipt.approved !== true || receipt.isAgent !== false) return refuse(REASONS.MISSING);
  if (typeof receipt.plan !== 'string') return refuse(REASONS.FIELD_TYPE);
  if (!receipt.plan.trim()) return refuse(REASONS.EMPTY);
  if (Buffer.byteLength(receipt.plan) > PLAN_FILE_MAX_BYTES) return refuse(REASONS.TOO_LARGE);
  return { ok: true, plan: receipt.plan, buffer: null, source };
}
module.exports = { resolveApprovedPlan, PLAN_FILE_MAX_BYTES, REASONS };
