/**
 * In-memory data store service
 * This stores all data in memory and will be lost on server restart
 */
class StoreService {
  constructor() {
    // Initialize in-memory storage
    this.smtpConfig = require('../config/default').smtp;
    this.drafts = [];
  }

  // SMTP Configuration
  getSmtpConfig() {
    return { ...this.smtpConfig };
  }

  setSmtpConfig(config) {
    this.smtpConfig = { ...config };
    return this.smtpConfig;
  }

  // Drafts
  getDrafts() {
    return [...this.drafts];
  }

  getDraftById(id) {
    return this.drafts.find(draft => draft.id === id) || null;
  }

saveDraft(draft) {
  const now = new Date();

  // IMPORTANT: Preserve HTML content exactly as provided without any modifications
  const draftToSave = {
    ...draft,
    html: draft.html || ''  // Store HTML exactly as is
  };

  if (draftToSave.id) {
    // Update existing draft
    const index = this.drafts.findIndex(d => d.id === draftToSave.id);
    if (index !== -1) {
      this.drafts[index] = {
        ...this.drafts[index],
        ...draftToSave,
        updatedAt: now
      };
      return this.drafts[index];
    }
  }

  // Add new draft
  const newDraft = {
    ...draftToSave,
    id: draftToSave.id || require('uuid').v4(),
    createdAt: now,
    updatedAt: now
  };

  this.drafts.push(newDraft);
  return newDraft;
}

  deleteDraft(id) {
    const index = this.drafts.findIndex(draft => draft.id === id);
    if (index !== -1) {
      const draft = this.drafts[index];
      this.drafts.splice(index, 1);
      return draft;
    }
    return null;
  }
}

// Create singleton instance
const storeService = new StoreService();

module.exports = storeService;