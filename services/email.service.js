const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const storeService = require('./store.service');
const mime = require('mime-types');
const juice = require('juice'); // <-- Add juice

class EmailService {
  /**
   * Send an email with HTML content and optional attachments
   * This will inline all CSS using juice, for maximum compatibility.
   */
  async sendEmail(emailData) {
    const smtpConfig = storeService.getSmtpConfig();

    if (!smtpConfig.host || !smtpConfig.auth.user || !smtpConfig.auth.pass) {
      throw new Error('SMTP configuration is incomplete. Please configure SMTP settings first.');
    }

    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        user: smtpConfig.auth.user,
        pass: smtpConfig.auth.pass
      }
    });

    const customSenderName = emailData.senderName || smtpConfig.senderName || 'Your Name';
    const fromEmail = smtpConfig.from || smtpConfig.auth.user;
    const formattedFrom = `"${customSenderName}" <${fromEmail}>`;

    // --- HTML PREP START ---
    let htmlContent = emailData.html;

    // Remove Quill wrappers if present (optional, keep if you use Quill)
    if (htmlContent.includes('ql-code-block-container')) {
      const matches = htmlContent.match(/<div class="ql-code-block">([\s\S]*?)<\/div>/);
      if (matches && matches[1]) {
        htmlContent = matches[1];
      }
      htmlContent = htmlContent
        .replace(/<div class="ql-code-block-container"[^>]*>/g, '')
        .replace(/<\/div>/g, '');
    }

    // Decode HTML entities if needed
    if (htmlContent.includes('&lt;')) {
      htmlContent = htmlContent
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');
    }

    // Wrap in full HTML structure if not already
    const hasDoctype = htmlContent.toLowerCase().includes('<!doctype') ||
                       htmlContent.toLowerCase().includes('<html');
    if (!hasDoctype) {
      htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${emailData.subject}</title>
  ${emailData.styles || ''} <!-- Optionally allow passing CSS styles -->
</head>
<body>
  ${htmlContent}
</body>
</html>`;
    }

    // Inline all CSS with juice
    htmlContent = juice(htmlContent);
    // --- HTML PREP END ---

    const mailOptions = {
      from: formattedFrom,
      to: emailData.to,
      subject: emailData.subject,
      html: htmlContent,
      contentType: 'text/html; charset=utf-8'
    };

    if (emailData.cc) mailOptions.cc = emailData.cc;
    if (emailData.bcc) mailOptions.bcc = emailData.bcc;

    // Attachments
    if (emailData.attachments && emailData.attachments.length > 0) {
      mailOptions.attachments = await Promise.all(emailData.attachments.map(async (attachment) => {
        const filePath = path.join('/tmp', attachment.filename);
        try {
          await fs.access(filePath);
        } catch (err) {
          console.error(`Attachment file not found: ${filePath}`);
          return null;
        }

        const mimeType = mime.lookup(attachment.originalname) || 'application/octet-stream';
        return {
          filename: attachment.originalname,
          path: filePath,
          contentType: mimeType,
          contentDisposition: 'attachment'
        };
      }));
      mailOptions.attachments = mailOptions.attachments.filter(att => att !== null);
    }

    // Send the email
    try {
      const info = await transporter.sendMail(mailOptions);

      // Optional: Delete attachments after sending
      if (emailData.attachments && emailData.attachments.length > 0) {
        for (const attachment of emailData.attachments) {
          try {
            const filePath = path.join('/tmp', attachment.filename);
            await fs.unlink(filePath);
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

  // ... testConnection, getSmtpStatus stay unchanged ...
  async testConnection(config) {
    // (same as your original)
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
      await transporter.verify();
      return { success: true, message: 'SMTP connection successful' };
    } catch (error) {
      console.error('SMTP test failed:', error);
      throw new Error(`SMTP test failed: ${error.message}`);
    }
  }

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

