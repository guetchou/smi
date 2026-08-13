'use strict';

const { can } = require('./permissions');
const { hasRole } = require('../routes/auth');

const WRITE_ROLES = ['admin', 'finance', 'caissier', 'dg'];
const PAY_ROLES = ['admin', 'finance', 'caissier'];

async function canWriteOperation(user, context = {}) {
  if (await can(user, 'cash.out.create', context)) return true;
  return hasRole(user, ...WRITE_ROLES);
}

async function canPayCashOut(user, context = {}) {
  if (await can(user, 'cash.out.pay', context)) return true;
  return hasRole(user, ...PAY_ROLES);
}

module.exports = {
  WRITE_ROLES,
  PAY_ROLES,
  canWriteOperation,
  canPayCashOut,
};
