const express = require('express');
const cors = require('cors');
const multer = require('multer');
const connectDB = require('./config/db');
require('dotenv').config();

const app = express();

app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/branches', require('./routes/branchRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/company', require('./routes/companyRoutes'));
app.use('/api/cart', require('./routes/cartRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/delivery-partners', require('./routes/deliveryPartnerRoutes'));
app.use('/api/delivery-challan', require('./routes/deliveryChallanRoutes'));
app.use('/api/invoices', require('./routes/invoiceRoutes'));

app.get('/', (req, res) => {
    res.json({ message: 'API is running...' });
});

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

app.use((err, req, res, next) => {
    console.error(err.stack);

    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            success: false,
            message: err.message
        });
    }

    if (err.message === 'Only PDF files are allowed' || err.message === 'Only image files are allowed') {
        return res.status(400).json({
            success: false,
            message: err.message
        });
    }

    res.status(500).json({
        success: false,
        message: 'Something went wrong!',
        error: err.message
    });
});

const ensureDbConnection = async () => {
    await connectDB();
};

module.exports = {
    app,
    ensureDbConnection
};
