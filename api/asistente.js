'use strict';

// Vercel deploys files in /api as serverless functions. Reuse the same
// validated handler as the standalone Node server to keep behavior consistent.
module.exports = require('../server').handleRequest;
