const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const emailService = require('../services/email.service');

// Send an email with HTML content properly preserved
router.post('/', asyncHandler(async (req, res) => {
  const emailData = req.body;

  // Validate required fields
  if (!emailData.to || !emailData.subject || !emailData.html) {
    return res.status(400).json({
      success: false,
      error: 'Missing required email fields'
    });
  }

  try {
    // Log that we're sending the email
    console.log(`Sending email to: ${emailData.to}`);
    console.log(`Subject: ${emailData.subject}`);
    console.log(`HTML content preview: ${emailData.html.substring(0, 100)}...`);

    // Send the email with preserved HTML formatting
    const result = await emailService.sendEmail(emailData);

    res.json({
      success: true,
      messageId: result.messageId,
      message: 'Email sent successfully'
    });
  } catch (error) {
    console.error('Email sending error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send email'
    });
  }
}));

// Get SMTP configuration status
router.get('/smtp-status', asyncHandler(async (req, res) => {
  const smtpConfig = emailService.getSmtpStatus();
  res.json({
    success: true,
    configured: smtpConfig.configured,
    host: smtpConfig.host,
    from: smtpConfig.from
  });
}));

// Test SMTP connection
router.post('/test-connection', asyncHandler(async (req, res) => {
  try {
    const result = await emailService.testConnection(req.body);
    res.json({
      success: true,
      message: 'SMTP connection successful'
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}));

module.exports = router;