'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const route = fs.readFileSync(
  path.join(root, 'backend/routes/pointeuse.js'),
  'utf8',
);

const frontend = fs.readFileSync(
  path.join(root, 'frontend/dashboard.html'),
  'utf8',
);

assert(
  route.includes("router.get('/daily'"),
  'La route GET /pointeuse/daily doit exister',
);

assert(
  route.includes('classifyAttendanceDay'),
  'La route doit utiliser le moteur canonique',
);

assert(
  route.includes('summary'),
  'La réponse doit exposer une synthèse',
);

assert(
  route.includes('days'),
  'La réponse doit exposer les journées agents',
);

assert(
  frontend.includes("/pointeuse/daily?date="),
  'Le frontend doit consommer le nouvel endpoint journalier',
);

assert(
  !frontend
    .slice(
      frontend.indexOf('async function ptLoadJournee()'),
      frontend.indexOf('async function ptLoadHistorique()'),
    )
    .includes("/pointeuse/stats?date="),
  'La vue journalière ne doit plus appeler /stats',
);

assert(
  frontend.includes('absent_injustifie'),
  'Le frontend doit afficher les statuts canoniques',
);

assert(
  frontend.includes('pointage_incomplet'),
  'Le frontend doit afficher les pointages incomplets',
);

assert(
  frontend.includes('Aucune anomalie'),
  'Le frontend doit rendre les anomalies',
);

console.log('attendance_daily_vertical_slice_test: OK');
