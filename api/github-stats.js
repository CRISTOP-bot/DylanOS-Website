'use strict';

// Keep the public stats endpoint available in Vercel deployments as well as
// when running server.js locally.
module.exports = require('../server').handleRequest;
