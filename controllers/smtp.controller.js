const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const adminAuth = require('../middleware/admin-auth');
const storeService = require('../services/store.service');
const emailService = require('../services/email.service');

// Get SMTP configuration (admin only)
router.get('/', adminAuth, asyncHandler(async (req, res) => {
  const config = storeService.getSmtpConfig();
  res.json(config);
}));

// Update SMTP configuration (admin only)
router.post('/', adminAuth, asyncHandler(async (req, res) => {
  const config = req.body;

  // Validate required fields
  if (!config.host || !config.port || !config.auth?.user || !config.auth?.pass) {
    return res.status(400).json({ error: 'Missing required SMTP configuration fields' });
  }

  const updatedConfig = storeService.setSmtpConfig(config);
  res.json(updatedConfig);
}));

// Test SMTP connection (admin only)
router.post('/test', adminAuth, asyncHandler(async (req, res) => {
  const config = req.body;

  // Validate required fields
  if (!config.host || !config.port || !config.auth?.user || !config.auth?.pass) {
    return res.status(400).json({ error: 'Missing required SMTP configuration fields' });
  }

  const result = await emailService.testConnection(config);
  res.json(result);
}));

module.exports = router;