const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const errorHandler = require('./middleware/error-handler');

console.log('🚀 Server starting up...');
console.log('📍 NODE_ENV:', process.env.NODE_ENV);
console.log('📍 PORT:', process.env.PORT || 3000);

// Create uploads directory if it doesn't exist
// NOTE: This will only work locally or in /tmp on Vercel
const uploadsDir = process.env.NODE_ENV === 'production' 
  ? path.join('/tmp', 'uploads') 
  : path.join(__dirname, 'uploads');

try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('✅ Created uploads directory:', uploadsDir);
  } else {
    console.log('✅ Uploads directory exists:', uploadsDir);
  }
} catch (error) {
  console.error('❌ Failed to create uploads directory:', error);
  // Continue anyway, as this might be a read-only filesystem
}

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

console.log('🔧 Setting up middleware...');

// CORS logging middleware (BEFORE cors middleware)
app.use((req, res, next) => {
  console.log('📨 Incoming Request:');
  console.log('  Method:', req.method);
  console.log('  URL:', req.url);
  console.log('  Path:', req.path);
  console.log('  Origin:', req.get('Origin') || 'No Origin');
  console.log('  User-Agent:', req.get('User-Agent') || 'No User-Agent');
  console.log('  Authorization:', req.get('Authorization') ? 'Present' : 'Missing');
  console.log('  Content-Type:', req.get('Content-Type') || 'Not set');
  next();
});

// Middleware
const corsOptions = {
  origin: ['https://smtp-send-ui.vercel.app', 'http://smtp-send-ui.vercel.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

console.log('🌐 CORS configuration:', corsOptions);

app.use(cors(corsOptions));

// Log CORS responses
app.use((req, res, next) => {
  const originalSend = res.send;
  res.send = function(data) {
    console.log('📤 Response sent:');
    console.log('  Status:', res.statusCode);
    console.log('  Headers:', res.getHeaders());
    return originalSend.call(this, data);
  };
  next();
});

app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Log all routes being registered
console.log('🛣️  Registering routes...');

// Route registration with logging
try {
  console.log('📝 Registering /api/smtp-config routes...');
  const smtpController = require('./controllers/smtp.controller');
  app.use('/api/smtp-config', smtpController);
  console.log('✅ SMTP controller loaded successfully');
} catch (error) {
  console.error('❌ Error loading SMTP controller:', error);
}

try {
  console.log('📧 Registering /api/send routes...');
  const emailController = require('./controllers/email.controller');
  app.use('/api/send', emailController);
  console.log('✅ Email controller loaded successfully');
} catch (error) {
  console.error('❌ Error loading Email controller:', error);
}

try {
  console.log('📄 Registering /api/drafts routes...');
  const draftController = require('./controllers/draft.controller');
  app.use('/api/drafts', draftController);
  console.log('✅ Draft controller loaded successfully');
} catch (error) {
  console.error('❌ Error loading Draft controller:', error);
}

try {
  console.log('📎 Registering /api/attachments routes...');
  const attachmentController = require('./controllers/attachment.controller');
  app.use('/api/attachments', attachmentController);
  console.log('✅ Attachment controller loaded successfully');
} catch (error) {
  console.error('❌ Error loading Attachment controller:', error);
}

// Health check
app.get('/api/health', (req, res) => {
  console.log('❤️  Health check requested');
  res.json({ 
    status: 'ok', 
    timestamp: getCurrentUTCTimestamp(),
    user: 'darrassipro'
  });
});

// Log unmatched routes (404 handler)
app.use('*', (req, res, next) => {
  console.log('🚫 Unmatched route:');
  console.log('  Method:', req.method);
  console.log('  URL:', req.originalUrl);
  console.log('  Available routes should be:');
  console.log('    GET  /api/health');
  console.log('    POST /api/smtp-config/test (if controller exists)');
  console.log('    POST /api/drafts/* (if controller exists)');
  
  res.status(404).json({
    error: 'Route not found',
    method: req.method,
    path: req.originalUrl,
    availableRoutes: [
      'GET /api/health',
      'POST /api/smtp-config/test',
      'POST /api/drafts/*'
    ]
  });
});

// Helper function to generate timestamp in the requested format
function getCurrentUTCTimestamp() {
  const now = new Date();
  return ${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')};
}

// Error handling middleware with detailed logging
app.use((error, req, res, next) => {
  console.error('💥 Error caught by middleware:');
  console.error('  Error:', error.message);
  console.error('  Stack:', error.stack);
  console.error('  Request:', req.method, req.originalUrl);
  
  if (errorHandler) {
    errorHandler(error, req, res, next);
  } else {
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Start server - ONLY for local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(🎉 Server running on port ${PORT});
  });
} else {
  console.log('🚀 Production mode - server will be handled by Vercel');
}

console.log('✅ Server setup complete!');

// THIS IS CRITICAL FOR VERCEL DEPLOYMENT - MUST EXPORT THE APP
module.exports = app;
