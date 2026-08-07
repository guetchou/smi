'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const assignment = fs.readFileSync(path.join(root, 'backend/services/organization_assignment.js'), 'utf8');
const hierarchy = fs.readFileSync(path.join(root, 'backend/services/organization_department_hierarchy.js'), 'utf8');

new Function(assignment);
new Function(hierarchy);

assert(assignment.includes("require('../db')"));
assert(!assignment.includes("require('../database')"));
assert(!assignment.includes('.prepare('));
assert(assignment.includes('function createOrganizationAssignmentService(db = defaultDb)'));
assert(assignment.includes('async function resolveAgentAssignment'));
assert(assignment.includes('async function synchronizeDepartmentManager'));
assert(assignment.includes('return db.transaction(async tx =>'));
assert(assignment.includes('ORG_ASSIGNMENT_TEST_FAILURE_AFTER_DEPARTMENT_UPDATE'));
assert(assignment.includes('createOrganizationAssignmentService'));

assert(hierarchy.includes("require('../db')"));
assert(!hierarchy.includes("require('../database')"));
assert(!hierarchy.includes('.prepare('));
assert(hierarchy.includes('async function activeFunction'));
assert(hierarchy.includes('async function effectiveManager'));
assert(hierarchy.includes('async function reconcileEffectiveManagers'));
assert(hierarchy.includes('organization.resolveAgentAssignment = async function'));
assert(hierarchy.includes('organization.assertSupervisorChange = async function'));
assert(hierarchy.includes('await organization.synchronizeDepartmentManager'));

console.log('organization_assignment_async_test: OK');
