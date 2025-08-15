const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const storeService = require('./store.service');
const mime = require('mime-types'); // Add this package for better MIME type detection

class EmailService {
  /**
   * Send an email with HTML content and optional attachments
   */
  async sendEmail(emailData) {
    const smtpConfig = storeService.getSmtpConfig();

    if (!smtpConfig.host || !smtpConfig.auth.user || !smtpConfig.auth.pass) {
      throw new Error('SMTP configuration is incomplete. Please configure SMTP settings first.');
    }

    // Create a nodemailer transporter
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        user: smtpConfig.auth.user,
        pass: smtpConfig.auth.pass
      }
    });

    // Use custom sender name from emailData if provided, fallback to config or default
    const customSenderName = emailData.senderName || smtpConfig.senderName || 'Your Name';
    const fromEmail = smtpConfig.from || smtpConfig.auth.user;

    // Format the From field - use quotes to handle special characters properly
    const formattedFrom = `"${customSenderName}" <${fromEmail}>`;

    // Extract raw HTML content from the data
    let htmlContent = emailData.html;

    // If HTML is wrapped in Quill code block container, extract the actual content
    if (htmlContent.includes('ql-code-block-container')) {
      // Extract content from ql-code-block
      const matches = htmlContent.match(/<div class="ql-code-block">([\s\S]*?)<\/div>/);
      if (matches && matches[1]) {
        htmlContent = matches[1];
      }

      // Remove any Quill-specific wrappers
      htmlContent = htmlContent
        .replace(/<div class="ql-code-block-container"[^>]*>/g, '')
        .replace(/<\/div>/g, '');
    }

    // Simple doctype check
    const hasDoctype = htmlContent.toLowerCase().includes('<!doctype') ||
                      htmlContent.toLowerCase().includes('<html');

    // If content doesn't have doctype/html tags and looks like it needs HTML parsing
    if (!hasDoctype && htmlContent.includes('&lt;')) {
      // Convert HTML entities to actual HTML tags
      htmlContent = htmlContent
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');
    }

    // Wrap in basic HTML structure if needed
    if (!hasDoctype) {
      htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${emailData.subject}</title>
</head>
<body>
  ${htmlContent}
</body>
</html>`;
    }

    // Build the email - IMPORTANT: Only HTML, no text version
    const mailOptions = {
      from: formattedFrom,
      to: emailData.to,
      subject: emailData.subject,
      html: htmlContent,
      contentType: 'text/html; charset=utf-8'
    };

    // Add CC and BCC if present
    if (emailData.cc) mailOptions.cc = emailData.cc;
    if (emailData.bcc) mailOptions.bcc = emailData.bcc;

    // Process attachments properly
    if (emailData.attachments && emailData.attachments.length > 0) {
      console.log(`Processing ${emailData.attachments.length} attachments`);

      // Better attachment handling
      mailOptions.attachments = await Promise.all(emailData.attachments.map(async (attachment) => {
        const filePath = path.join(__dirname, '../uploads', attachment.filename);

        // Check if file exists
        try {
          await fs.access(filePath);
          console.log(`Found attachment file: ${filePath}`);
        } catch (err) {
          console.error(`Attachment file not found: ${filePath}`);
          // Return empty for this attachment
          return null;
        }

        // Detect MIME type from file extension
        const mimeType = mime.lookup(attachment.originalname) || 'application/octet-stream';
        console.log(`Detected MIME type for ${attachment.originalname}: ${mimeType}`);

        return {
          filename: attachment.originalname,
          path: filePath,
          contentType: mimeType,
          contentDisposition: 'attachment' // Explicitly set as attachment
        };
      }));

      // Filter out any null attachments (files not found)
      mailOptions.attachments = mailOptions.attachments.filter(att => att !== null);
    }

    // Send the email
    try {
      console.log(`Sending email to ${emailData.to} with ${mailOptions.attachments?.length || 0} attachments`);
      const info = await transporter.sendMail(mailOptions);

      // Delete attachments after successful send
      if (emailData.attachments && emailData.attachments.length > 0) {
        for (const attachment of emailData.attachments) {
          try {
            const filePath = path.join(__dirname, '../uploads', attachment.filename);
            await fs.unlink(filePath);
            console.log(`Deleted attachment: ${filePath}`);
          } catch (err) {
            console.error(`Error deleting attachment ${attachment.filename}:`, err);
          }
        }
      }

      return info;
    } catch (error) {
      console.error('Error sending email:', error);
      throw error;
    }
  }

  /**
   * Test SMTP connection
   */
  async testConnection(config) {
    try {
      const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
          user: config.auth.user,
          pass: config.auth.pass
        }
      });

      // Verify connection
      await transporter.verify();
      return { success: true, message: 'SMTP connection successful' };
    } catch (error) {
      console.error('SMTP test failed:', error);
      throw new Error(`SMTP test failed: ${error.message}`);
    }
  }

  /**
   * Get SMTP status
   */
  getSmtpStatus() {
    const config = storeService.getSmtpConfig();
    return {
      configured: !!(config.host && config.auth.user && config.auth.pass),
      host: config.host,
      from: config.from || config.auth.user,
      senderName: config.senderName || ''
    };
  }
}

module.exports = new EmailService();