const auth = require('basic-auth');
const config = require('../config/default');

/**
 * Middleware to authenticate admin requests using Basic Auth
 */
module.exports = (req, res, next) => {
  const user = auth(req);

  if (!user || user.name !== config.admin.username || user.pass !== config.admin.password) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  next();
};