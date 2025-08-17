module.exports = {
  admin: {
    username: 'admin',
    password: 'supersecret'
  },
  smtp: {
    // Default SMTP config (will be overridden by admin)
    host: '',
    port: 465,
    secure: false,
    auth: {
      user: '',
      pass: ''
    },
    from: ''
  }

};
