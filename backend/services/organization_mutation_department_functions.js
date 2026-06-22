'use strict';

const workflow = require('./organization_mutation_workflow');
const { withRequestedSupervisor } = require('./organization_department_hierarchy');

function installMutationDepartmentFunctions() {
  if (workflow.__departmentFunctionsInstalled) return workflow;

  const original = {
    createDraft: workflow.createDraft.bind(workflow),
    updateDraft: workflow.updateDraft.bind(workflow),
    submit: workflow.submit.bind(workflow),
    approve: workflow.approve.bind(workflow),
    apply: workflow.apply.bind(workflow),
  };

  workflow.createDraft = function createDraftWithDepartmentFunction(input, actorUserId) {
    return withRequestedSupervisor(input?.nouveau_sup_id, () => original.createDraft(input, actorUserId));
  };

  workflow.updateDraft = function updateDraftWithDepartmentFunction(id, input, actorUserId) {
    const current = workflow.getMutation(id);
    const requested = input?.nouveau_sup_id === undefined ? current?.nouveau_sup_id : input.nouveau_sup_id;
    return withRequestedSupervisor(requested, () => original.updateDraft(id, input, actorUserId));
  };

  workflow.submit = function submitWithDepartmentFunction(id, actorUserId) {
    const current = workflow.getMutation(id);
    return withRequestedSupervisor(current?.nouveau_sup_id, () => original.submit(id, actorUserId));
  };

  workflow.approve = function approveWithDepartmentFunction(id, actorUserId) {
    const current = workflow.getMutation(id);
    return withRequestedSupervisor(current?.nouveau_sup_id, () => original.approve(id, actorUserId));
  };

  workflow.apply = function applyWithDepartmentFunction(id, actorUserId) {
    const current = workflow.getMutation(id);
    return withRequestedSupervisor(current?.nouveau_sup_id, () => original.apply(id, actorUserId));
  };

  workflow.__departmentFunctionsInstalled = true;
  return workflow;
}

module.exports = { installMutationDepartmentFunctions };
