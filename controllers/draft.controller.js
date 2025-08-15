const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const storeService = require('../services/store.service');
const fs = require('fs').promises;
const path = require('path');

// Get all drafts
router.get('/', asyncHandler(async (req, res) => {
  const drafts = storeService.getDrafts();
  res.json(drafts);
}));

// Save a draft
router.post('/', asyncHandler(async (req, res) => {
  const draft = req.body;

  // Validate required fields
  if (!draft.to || !draft.subject || !draft.html) {
    return res.status(400).json({ error: 'Missing required draft fields' });
  }

  const savedDraft = storeService.saveDraft(draft);
  res.json(savedDraft);
}));

// Delete a draft
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const draft = storeService.deleteDraft(id);

  if (!draft) {
    return res.status(404).json({ error: 'Draft not found' });
  }

  // If draft has attachments, delete them
  if (draft.attachments && draft.attachments.length > 0) {
    for (const attachment of draft.attachments) {
      try {
        await fs.unlink(path.join(__dirname, '../uploads', attachment.filename));
        console.log(`Deleted attachment from draft: ${attachment.filename}`);
      } catch (err) {
        console.error(`Error deleting attachment ${attachment.filename}:`, err);
        // Continue even if file deletion fails
      }
    }
  }

  res.json({ success: true, id });
}));

module.exports = router;