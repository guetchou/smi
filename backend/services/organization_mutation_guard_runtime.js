'use strict';

const organizationSvc = require('./organization_assignment');

const ORGANIZATION_FIELDS = ['poste', 'departement', 'site', 'superieur_id', 'superieur_hierarchique'];

function normalize(field, value) {
  if (field === 'superieur_id') return value === undefined || value === null || value === '' ? null : Number(value);
  return String(value ?? '').trim();
}

function installOrganizationMutationGuard() {
  if (organizationSvc.__mutationWorkflowGuardInstalled) return organizationSvc;

  const originalResolve = organizationSvc.resolveAgentAssignment.bind(organizationSvc);
  organizationSvc.resolveAgentAssignment = function resolveWithMutationGuard(payload, options = {}) {
    if (options.employeeId && options.current && !options.allowMutationWorkflow) {
      const changedFields = ORGANIZATION_FIELDS.filter(field => (
        normalize(field, payload?.[field]) !== normalize(field, options.current?.[field])
      ));
      if (changedFields.length) {
        throw new organizationSvc.OrganizationRuleError(
          'Les modifications de poste, département, site ou supérieur doivent passer par une mutation RH.',
          'USE_ORGANIZATION_MUTATION_WORKFLOW',
          409,
          { changed_fields: changedFields, workflow_endpoint: '/api/org/mutations' },
        );
      }
    }
    return originalResolve(payload, options);
  };

  organizationSvc.__mutationWorkflowGuardInstalled = true;
  return organizationSvc;
}

module.exports = { installOrganizationMutationGuard };
