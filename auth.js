const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'gcm_secret_change_on_vps_2025';
const JWT_EXPIRES = '7d';

function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function requireAuth(req, res, next) {
    const token = req.cookies && req.cookies.gcm_token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (e) {
        res.clearCookie('gcm_token');
        return res.status(401).json({ error: 'Session expired' });
    }
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        next();
    });
}

module.exports = { signToken, requireAuth, requireAdmin, JWT_SECRET };
