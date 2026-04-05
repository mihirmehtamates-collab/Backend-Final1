const mongoose = require('mongoose');
require('dotenv').config();

let cachedConnection = null;
let connectionPromise = null;

const connectDB = async () => {
    try {
        const mongoUri = process.env.MONGO_URI;

        if (!mongoUri) {
            throw new Error('MONGO_URI is not set. Add it to your environment variables or .env file before starting the server.');
        }

        if (cachedConnection && mongoose.connection.readyState === 1) {
            return cachedConnection;
        }

        if (connectionPromise) {
            return connectionPromise;
        }

        connectionPromise = mongoose.connect(mongoUri).then((mongooseInstance) => {
            cachedConnection = mongooseInstance;
            console.log('MongoDB connected');
            return mongooseInstance;
        });

        return await connectionPromise;
    } catch (error) {
        connectionPromise = null;
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
}

module.exports = connectDB; 
