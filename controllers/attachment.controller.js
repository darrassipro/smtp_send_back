const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

// Multer storage for Vercel-compatible temp folder
// Use /tmp for Vercel
const storage = multer.diskStorage({
  destination: '/tmp',
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});

const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });


// Upload file
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  console.log('Incoming file:', req.file);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
}));

// Delete file
router.delete('/:filename', asyncHandler(async (req, res) => {
  const filePath = path.join('/tmp', req.params.filename);
  try {
    await fs.unlink(filePath);
    res.json({ success: true, filename: req.params.filename });
  } catch (err) {
    console.error('Delete error:', err);
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    throw err;
  }
}));

module.exports = router;
