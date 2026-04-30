const express = require('express');
const cors = require('cors');
const path = require('path');
const { router: authRouter, requireAuth } = require('./routes/auth');
const operationsRouter = require('./routes/operations');
const usersRouter      = require('./routes/users');
const salairesRouter   = require('./routes/salaires');
const agentsRouter     = require('./routes/agents');

const app = express();
const PORT = process.env.PORT || 3337;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Serve uploaded photos (volume Docker persistant)
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/operations', requireAuth, operationsRouter);
app.use('/api/config', requireAuth, usersRouter);
app.use('/api/salaires', requireAuth, salairesRouter);
app.use('/api/agents',  requireAuth, agentsRouter);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Caisse TOP CENTER démarrée sur le port ${PORT}`);
  console.log(`   Admin: admin@topcenter.cg / Admin@2025!`);
});
