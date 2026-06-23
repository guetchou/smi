'use strict';

const notifSvc = require('./notif');
const { installDepartmentFunctionCreateDraftFix } = require('./department_function_create_draft_fix');

function installDepartmentFunctionNotificationGuard() {
  installDepartmentFunctionCreateDraftFix();
  if (notifSvc.__departmentFunctionGuardInstalled) return;
  const original = notifSvc.creerNotification.bind(notifSvc);
  notifSvc.creerNotification = async function guardedNotification(options = {}) {
    const organizationType = String(options.type || '').startsWith('ORG_FUNCTION_');
    if (organizationType
        && (process.env.NODE_ENV === 'test'
          || process.env.ORG_FUNCTION_NOTIFICATIONS_DISABLED === '1')) {
      return [];
    }
    try {
      return await original(options);
    } catch (error) {
      if (organizationType) {
        console.error('[ORG fonction notification]', options.type, error.message);
        return { sent: 0, failed: true, error: error.message };
      }
      throw error;
    }
  };
  notifSvc.__departmentFunctionGuardInstalled = true;
}

module.exports = { installDepartmentFunctionNotificationGuard };
