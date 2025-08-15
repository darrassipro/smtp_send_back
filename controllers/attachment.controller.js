const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../uploads'));
  },
  filename: function (req, file, cb) {
    // Generate unique filename to prevent collisions
    const uniqueFilename = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  }
});

// Create multer upload instance
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB file size limit
  }
});

// Upload a file
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
}));

// Delete a file
router.delete('/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;

  try {
    await fs.unlink(path.join(__dirname, '../uploads', filename));
    res.json({ success: true, filename });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    throw error;
  }
}));

module.exports = router;