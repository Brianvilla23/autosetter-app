/**
 * Atinov — Usage Route
 *
 * GET /api/usage → devuelve el uso actual + los límites del plan del usuario.
 * El frontend usa esto para la card "Uso del mes" en Dashboard.
 */

const express = require('express');
const router  = express.Router();
const { getUsage } = require('../services/limits');

router.get('/', async (req, res) => {
  try {
    const data = await getUsage(req.user.userId);
    res.json(data);
  } catch (e) {
    console.error('GET /usage error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
