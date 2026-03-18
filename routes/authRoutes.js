const express = require('express');
const router = express.Router();
const upload = require('../middleware/uploadMiddleware');
const { 
    signup, 
    login, 
    getMe,
    getAllVendors,
    getAllCompanies,
    getStats,
    approveUser, 
    rejectUser,
    bulkApprove,
    bulkReject,
    forgotPassword,      
    verifyOTP,           
    resetPassword        
} = require('../controllers/authController');
const { updateUser, deleteUser } = require('../controllers/userController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Public routes
router.post('/signup', upload.single('seCertificate'), signup);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/verify-otp', verifyOTP);
router.post('/reset-password', resetPassword);

// Protected routes
router.get('/me', protect, getMe);

// Admin and Sub-Admin routes
router.get('/vendors', protect, authorize('admin', 'sub-admin'), getAllVendors);
router.get('/companies', protect, authorize('admin', 'sub-admin'), getAllCompanies);
router.get('/stats', protect, authorize('admin', 'sub-admin'), getStats);
router.put('/approve/:userId', protect, authorize('admin', 'sub-admin'), approveUser);
router.put('/reject/:userId', protect, authorize('admin', 'sub-admin'), rejectUser);
router.put('/bulk-approve', protect, authorize('admin', 'sub-admin'), bulkApprove);
router.put('/bulk-reject', protect, authorize('admin', 'sub-admin'), bulkReject);
router.put('/users/:id', protect, authorize('admin', 'sub-admin'), updateUser);
router.delete('/users/:id', protect, authorize('admin', 'sub-admin'), deleteUser);

module.exports = router;