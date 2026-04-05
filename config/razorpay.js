const Razorpay = require('razorpay');

let razorpayInstance = null;

const getRazorpayInstance = () => {
    if (razorpayInstance) {
        return razorpayInstance;
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
        throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in environment variables.');
    }

    razorpayInstance = new Razorpay({
        key_id: keyId,
        key_secret: keySecret
    });

    return razorpayInstance;
};

module.exports = getRazorpayInstance;
