const jwt = require('jsonwebtoken');

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Token ausente.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'jg_motos_super_secret');
    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Token inválido.' });
  }
}

module.exports = { authRequired };
