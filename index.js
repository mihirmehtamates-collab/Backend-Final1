const { app, ensureDbConnection } = require('./app');

const PORT = process.env.PORT || 5000;

const startServer = async () => {
    await ensureDbConnection();

    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
};

startServer();
