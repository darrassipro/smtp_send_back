const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const errorHandler = require('./middleware/error-handler');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
const corsOptions = {
  origin: [
    'https://smtp-send-ui.vercel.app',
    'http://smtp-send-ui.vercel.app',
    'http://localhost:4200'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Routes
app.use('/api/smtp-config', require('./controllers/smtp.controller'));
app.use('/api/send', require('./controllers/email.controller'));
app.use('/api/drafts', require('./controllers/draft.controller'));
app.use('/api/attachments', require('./controllers/attachment.controller')); // uses /tmp internally

// Root endpoint
app.get('/', (req, res) => {
  res.send('Server is up and running 🚀');
});
// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

