const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

// Multer storage for Vercel-compatible temp folder
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, '/tmp'); // Vercel allows only /tmp for write access
  },
  filename: function (req, file, cb) {
    const uniqueFilename = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Upload file endpoint
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  console.log('Incoming file upload:', req.file);

  if (!req.file) {
    console.error('No file uploaded!');
    return res.status(400).json({ error: 'No file uploaded' });
  }

  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
}));

// Delete file endpoint (temporary folder)
router.delete('/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const filePath = path.join('/tmp', filename);

  try {
    await fs.unlink(filePath);
    res.json({ success: true, filename });
  } catch (error) {
    console.error('Delete file error:', error);
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    throw error;
  }
}));

module.exports = router;
