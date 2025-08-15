const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const errorHandler = require('./middleware/error-handler');

// Create uploads directory if it doesn't exist
// NOTE: This will only work locally or in /tmp on Vercel
const uploadsDir = process.env.NODE_ENV === 'production' 
  ? path.join('/tmp', 'uploads') 
  : path.join(__dirname, 'uploads');

try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (error) {
  console.error('Failed to create uploads directory:', error);
  // Continue anyway, as this might be a read-only filesystem
}

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;


// Middleware
app.use(cors({
  origin: ['https://smtp-send-ui.vercel.app', 'http://smtp-send-ui.vercel.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));


// Routes
app.use('/api/smtp-config', require('./controllers/smtp.controller'));
app.use('/api/send', require('./controllers/email.controller'));
app.use('/api/drafts', require('./controllers/draft.controller'));
app.use('/api/attachments', require('./controllers/attachment.controller'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: getCurrentUTCTimestamp(),
    user: 'darrassipro'
  });
});

// Helper function to generate timestamp in the requested format
function getCurrentUTCTimestamp() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}`;
}

// Error handling middleware
app.use(errorHandler);

// Start server - ONLY for local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// THIS IS CRITICAL FOR VERCEL DEPLOYMENT - MUST EXPORT THE APP
module.exports = app;

