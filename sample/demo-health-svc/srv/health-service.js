const cds = require('@sap/cds');

const START_TIME = Date.now();
const VERSION = require('../package.json').version;

module.exports = class HealthService extends cds.ApplicationService {
  async init() {
    this.on('ping', () => 'pong');

    this.on('status', () => ({
      status: 'UP',
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      version: VERSION,
    }));

    return super.init();
  }
};
