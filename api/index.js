const { app, ensureDbConnection } = require('../app');

module.exports = async (req, res) => {
    await ensureDbConnection();
    return app(req, res);
};
