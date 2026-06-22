'use strict';

const organization = require('./organization_assignment');

const FIELDS = ['poste', 'departement', 'site', 'superieur_id', 'superieur_hierarchique'];

function normalize(field, value) {
  if (field === 'superieur_id') {
    return value === undefined || value === null || value === '' ? null : Number(value);
  }
  return String(value ?? '').trim();
}

function installOrganizationMutationGuard() {
  if (organization.__mutationWorkflowGuardInstalled) return;

  const originalResolve = organization.resolveAgentAssignment.bind(organization);
  organization.resolveAgentAssignment = function guardedResolve(payload, options = {}) {
    if (options.employeeId && options.current && !options.allowMutationWorkflow) {
      const changedFields = FIELDS.filter(field => (
        normalize(field, payload?.[field]) !== normalize(field, options.current?.[field])
      ));
      if (changedFields.length) {
        throw new organization.OrganizationRuleError(
          'Les modifications de poste, département, site ou supérieur doivent passer par une mutation RH.',
          'USE_ORGANIZATION_MUTATION_WORKFLOW',
          409,
          { changed_fields: changedFields, workflow_endpoint: '/api/org/mutations' },
        );
      }
    }
    return originalResolve(payload, options);
  };

  organization.__mutationWorkflowGuardInstalled = true;
}

module.exports = { FIELDS, installOrganizationMutationGuard };
