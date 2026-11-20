export function pendingApprovalBatch(body, pending, httpError) {
  const { project, scope, approvalIds, allow } = body;
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 80;
  if (allow !== true || Object.hasOwn(body, 'approvalId') || !validId(project) || !validId(scope) ||
      !Array.isArray(approvalIds) || !approvalIds.length || approvalIds.length > 60 ||
      !approvalIds.every(validId) || new Set(approvalIds).size !== approvalIds.length) {
    throw httpError(400, 'Provide the project, chat, and distinct pending request IDs to approve.');
  }
  return approvalIds.map(id => {
    const entry = pending.get(id);
    if (!entry || entry.signal.aborted) {
      throw httpError(409, 'The pending requests changed. Review the current list and try again.');
    }
    if (entry.meta?.projectId !== project || entry.meta?.scope !== scope || entry.card.batchEligible !== true) {
      throw httpError(409, 'One of these requests needs individual approval or belongs to another chat.');
    }
    return entry;
  });
}
