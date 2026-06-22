'use strict';

const db = require('../database');
const functions = require('./organization_department_functions');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function installDepartmentFunctionSafety() {
  if (functions.__safetyInstalled) return functions;

  const originalCreate = functions.createFunction.bind(functions);
  functions.createFunction = function createFunctionSafely(departmentId, input, actorUserId = null) {
    const type = String(input?.fonction_type || '').trim();
    const start = String(input?.date_debut || today()).trim();
    if (type === 'chef' && start > today()) {
      throw new functions.DepartmentFunctionError(
        'La nomination future d’un chef doit être exécutée à sa date d’effet. Aucune hiérarchie n’a été modifiée.',
        'FUTURE_CHIEF_EFFECTIVE_DATE_REQUIRED',
        409,
        { date_debut: start },
      );
    }

    const execute = db.transaction(() => originalCreate(departmentId, input, actorUserId));
    return execute();
  };

  functions.__safetyInstalled = true;
  return functions;
}

module.exports = { installDepartmentFunctionSafety };
