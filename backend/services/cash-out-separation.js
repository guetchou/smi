'use strict';

class CashOutSeparationError extends Error {
  constructor(message, code, status = 409, details = {}) {
    super(message);
    this.name = 'CashOutSeparationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function assertApprovalSeparation(operation, actorUserId) {
  const actorId = Number(actorUserId || 0);
  const createdBy = Number(operation?.created_by || 0);
  const submittedBy = Number(operation?.submitted_by || 0);

  if (!actorId) {
    throw new CashOutSeparationError(
      'Utilisateur approbateur introuvable.',
      'CASH_OUT_APPROVER_REQUIRED',
      403,
    );
  }

  if ((createdBy && createdBy === actorId) || (submittedBy && submittedBy === actorId)) {
    throw new CashOutSeparationError(
      'L’initiateur ou le soumetteur ne peut pas valider son propre décaissement.',
      'CASH_OUT_SELF_APPROVAL_FORBIDDEN',
      409,
      {
        actor_user_id: actorId,
        created_by: createdBy || null,
        submitted_by: submittedBy || null,
      },
    );
  }

  return true;
}

module.exports = {
  CashOutSeparationError,
  assertApprovalSeparation,
};
