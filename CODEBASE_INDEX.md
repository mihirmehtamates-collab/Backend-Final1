# Codebase Index

## Overview

This repository is a Node.js backend built with Express and Mongoose.

- Entrypoint: `index.js`
- HTTP framework: `express`
- Database layer: `mongoose` via `config/db.js`
- Auth: JWT-based middleware in `middleware/authMiddleware.js`
- Payments: Razorpay via `config/razorpay.js`
- Media/file handling: `multer`, Cloudinary, custom upload helpers

The app mounts 10 route modules and is organized into 44 first-level source files across `routes`, `controllers`, `models`, `middleware`, `config`, and `utils`.

## App Bootstrap

### `index.js`

Responsibilities:

- Loads environment variables
- Connects to MongoDB
- Configures CORS and body parsing
- Mounts all API route groups under `/api/*`
- Handles 404s and central error responses

Mounted route prefixes:

- `/api/auth`
- `/api/admin`
- `/api/branches`
- `/api/products`
- `/api/company`
- `/api/cart`
- `/api/orders`
- `/api/delivery-partners`
- `/api/delivery-challan`
- `/api/invoices`

## Directory Map

### `config/`

- `db.js`: MongoDB connection bootstrap
- `cloudinary.js`: Cloudinary client setup
- `razorpay.js`: Razorpay client instance

### `middleware/`

- `authMiddleware.js`: user/company auth guards and role authorization
- `uploadMiddleware.js`: PDF/file upload middleware
- `imageUploadMiddleware.js`: image upload middleware for product images

### `models/`

- `User.js`: admin/vendor/company-style user records
- `CompanyUser.js`: company-side users and limits
- `Branch.js`: branch ownership, approval, assignment
- `Category.js`: product categories
- `SubCategory.js`: product subcategories
- `Product.js`: catalog items, images, approval/status flow
- `Cart.js`: company user shopping cart
- `Order.js`: placed orders and payment/order lifecycle
- `OrderEscalation.js`: escalation workflow around orders
- `DeliveryPartner.js`: delivery partner records and assignments
- `DeliveryChallan.js`: challan header/items linked to orders
- `Invoice.js`: invoice generation and payment tracking

### `controllers/`

- `authController.js`: signup/login/password reset plus vendor/company approval flows
- `adminController.js`: sub-admin/vendor/company creation and branch oversight
- `branchController.js`: branch CRUD, stats, admin assignment
- `productController.js`: product CRUD, moderation, stats, listing
- `cartController.js`: cart retrieval, add/update/remove/clear flows
- `orderController.js`: order placement, payment verification, escalations, vendor/admin actions
- `companyController.js`: company login, dashboard, users, monthly limits
- `deliveryPartnerController.js`: delivery partner CRUD and order assignment
- `deliveryChallanController.js`: challan creation and listing
- `invoiceController.js`: invoice CRUD and payment verification
- `categoryController.js`: category/subcategory CRUD and toggles
- `userController.js`: user update/delete helpers

### `routes/`

- `authRoutes.js`
- `adminRoutes.js`
- `branchRoutes.js`
- `productRoutes.js`
- `companyRoutes.js`
- `cartRoutes.js`
- `orderRoutes.js`
- `deliveryPartnerRoutes.js`
- `deliveryChallanRoutes.js`
- `invoiceRoutes.js`

### `utils/`

- `emailService.js`: credential and OTP email sending
- `fileUpload.js`: generic file upload helper(s)
- `imageUpload.js`: image upload/storage helper(s)
- `numberToWords.js`: invoice-style numeric amount conversion

## Auth Model

Primary auth middleware lives in `middleware/authMiddleware.js`.

Key guards:

- `protect`: standard JWT-backed user auth
- `authorize(...roles)`: role filtering for admin/vendor-style users
- `optionalAuth`: enriches request context without requiring auth
- `protectCompany`: company-specific auth flow
- `authorizeCompanyRole(...roles)`: company role filtering
- `authorizeCompanyUser`: ensures request is from a company-side user

Observed role families in the route layer:

- `admin`
- `sub-admin`
- `vendor`
- `super-admin`
- `company-admin`
- `user`

## API Index

### `/api/auth`

Purpose: user auth and admin-side user approval/management.

Key endpoints:

- `POST /signup`
- `POST /login`
- `POST /forgot-password`
- `POST /verify-otp`
- `POST /reset-password`
- `GET /me`
- `GET /vendors`
- `GET /companies`
- `GET /stats`
- `PUT /approve/:userId`
- `PUT /reject/:userId`
- `PUT /bulk-approve`
- `PUT /bulk-reject`
- `PUT /users/:id`
- `DELETE /users/:id`

### `/api/admin`

Purpose: admin/sub-admin operations around dashboards, users, branches, and taxonomy.

Key endpoints:

- `GET /dashboard`
- `GET /my-store/dashboard`
- `POST /create-sub-admin`
- `GET /sub-admins`
- `PUT /toggle-status/:userId`
- `GET /branches/stats`
- `GET /branches`
- `PUT /branches/approve/:branchId`
- `PUT /branches/reject/:branchId`
- `PUT /branches/toggle-status/:branchId`
- `POST /create-vendor`
- `POST /create-company`
- `POST /categories`
- `GET /categories`
- `PUT /categories/:categoryId/toggle-status`
- `DELETE /categories/:categoryId`
- `POST /sub-categories`
- `GET /sub-categories`
- `PUT /sub-categories/:subCategoryId/toggle-status`
- `DELETE /sub-categories/:subCategoryId`

### `/api/branches`

Purpose: branch CRUD, stats, and admin assignment.

Key endpoints:

- `POST /create`
- `GET /my-branches`
- `GET /stats`
- `GET /:branchId`
- `PUT /:branchId`
- `PUT /:branchId/assign-admin`
- `DELETE /:branchId`

### `/api/products`

Purpose: product browsing, vendor product management, and admin moderation.

Key endpoints:

- `GET /`
- `GET /my-products`
- `GET /admin/my-products`
- `GET /stats`
- `POST /`
- `PUT /:productId`
- `DELETE /:productId`
- `PUT /:productId/toggle-status`
- `PUT /:productId/approve`
- `PUT /:productId/reject`
- `GET /:productId`

### `/api/company`

Purpose: company-side auth, dashboards, user management, and spending limits.

Key endpoints:

- `POST /login`
- `GET /me`
- `GET /dashboard`
- `GET /stats`
- `GET /my-limit`
- `GET /users/:userId/limit`
- `PUT /users/:userId/set-limit`
- `GET /users`
- `GET /users/:userId`
- `POST /create-admin`
- `DELETE /users/:userId`
- `PUT /users/:userId/reassign-branch`
- `POST /create-user`
- `PUT /users/:userId/toggle-status`

### `/api/cart`

Purpose: shopping cart operations for company users.

Key endpoints:

- `GET /`
- `POST /add`
- `PATCH /update/:productId`
- `DELETE /remove/:productId`
- `DELETE /clear`

### `/api/orders`

Purpose: order lifecycle, payment verification, escalations, and vendor/admin approval handling.

Key endpoints:

- `POST /place`
- `POST /verify-payment`
- `POST /escalate`
- `GET /escalations/received`
- `GET /escalations/sent`
- `PUT /escalations/:escalationId/approve`
- `PUT /escalations/:escalationId/reject`
- `GET /vendor/my-orders`
- `PUT /vendor/:orderId/approve`
- `PUT /vendor/:orderId/reject`
- `GET /admin/my-orders`
- `PUT /admin/my-orders/:orderId/approve`
- `PUT /admin/my-orders/:orderId/reject`
- `PUT /admin/:orderId/reject-order`
- `GET /`
- `GET /:orderId/payment-status`
- `GET /:orderId`

### `/api/delivery-partners`

Purpose: delivery partner management and assignment to orders.

Key endpoints:

- `POST /`
- `GET /`
- `GET /:id`
- `PUT /:id`
- `DELETE /:id`
- `PUT /assign/:orderId`
- `DELETE /assign/:orderId`
- `GET /:id/orders`

### `/api/delivery-challan`

Purpose: challan creation and retrieval for vendor/admin workflows.

Key endpoints:

- `POST /`
- `GET /vendor/my-challans`
- `GET /admin/my-challans`
- `GET /all`
- `GET /order/:orderId`

### `/api/invoices`

Purpose: invoice issuance, lookup, deletion, and payment verification.

Key endpoints:

- `POST /`
- `POST /verify-payment`
- `GET /`
- `GET /order/:orderId`
- `GET /:invoiceId`
- `DELETE /:invoiceId`

## Notable Domain Flows

### Commerce flow

- Product catalog managed by vendors
- Company-side users add products to cart
- Orders are placed and payment is verified
- Vendors/admins review order actions
- Delivery partners can be assigned
- Delivery challans and invoices are generated downstream

### Approval flow

- Admin/sub-admin approves vendors, companies, branches, and products
- Company roles govern internal user creation, status, and budget limits

### Finance flow

- Razorpay appears in both order and invoice payment verification flows
- `utils/numberToWords.js` suggests printable invoice/amount rendering support

## Suggested Navigation Order

If you need to understand the system quickly, read files in this order:

1. `index.js`
2. `middleware/authMiddleware.js`
3. `routes/*.js`
4. `controllers/orderController.js`
5. `controllers/productController.js`
6. `controllers/companyController.js`
7. `models/Order.js`
8. `models/Product.js`
9. `models/DeliveryChallan.js`
10. `models/Invoice.js`

## Notes

- `node_modules/` is checked into the repository and should usually be ignored during navigation.
- `package.json` has no working test script, so there is no built-in automated test entrypoint yet.
- The codebase centers on B2B ordering with admin, vendor, and company-user role separation.
