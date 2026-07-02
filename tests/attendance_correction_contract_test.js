'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const route = fs.readFileSync(
  path.join(root, 'backend/routes/pointeuse.js'),
  'utf8'
);
const frontend = fs.readFileSync(
  path.join(root, 'frontend/dashboard.html'),
  'utf8'
);

assert(
  route.includes("router.patch('/:id/correction'"),
  'Une route canonique PATCH /:id/correction doit exister'
);

assert(
  route.includes('CORRECTION_REASON_REQUIRED'),
  'Le motif de correction doit être obligatoire'
);

assert(
  route.includes('ATTENDANCE_PERIOD_CLOSED'),
  'Une période clôturée doit bloquer la correction'
);

assert(
  route.includes('before_state'),
  'L’audit doit conserver l’état avant correction'
);

assert(
  route.includes('after_state'),
  'L’audit doit conserver l’état après correction'
);

assert(
  route.includes("action: 'attendance_correction'"),
  'L’action d’audit doit être explicite'
);

assert(
  frontend.includes('/correction'),
  'Le frontend doit appeler la route canonique de correction'
);

assert(
  frontend.includes('Motif de correction'),
  'Le formulaire doit afficher le motif métier'
);

assert(
  frontend.includes('Résumé avant validation'),
  'Le frontend doit montrer un résumé avant validation'
);

console.log('attendance_correction_contract_test: OK');
