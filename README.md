# PizzaHub — Backend API

PizzaHub is the backend API for a role-based pizza ordering platform. It provides authentication verification, menu management, order processing, administrative operations, and vendor Premium subscriptions.

**Live API:** https://pizzahub-server-lemon.vercel.app

**Health Check:** https://pizzahub-server-lemon.vercel.app/api/health

**Client Repository:** https://github.com/iamminhaz31/pizzahub-client

**Server Repository:** https://github.com/iamminhaz31/pizzahub-server

## Technology Stack

- **Runtime:** Node.js
- **Backend Framework:** Express.js 5
- **Database:** MongoDB Atlas
- **Authentication Verification:** Better Auth JWT and jose
- **Token Verification:** Remote JWKS
- **Payment Integration:** Stripe
- **Cross-Origin Resource Sharing:** CORS

## Architecture

PizzaHub uses a separate Next.js frontend and Express backend.

The backend connects to MongoDB Atlas using the official MongoDB Node.js driver.

### Authentication and Authorization

- Better Auth manages user authentication on the client.
- The client receives a short-lived JWT.
- Express verifies JWT signatures using Better Auth's JWKS endpoint.
- The jose library validates the token issuer, audience, and algorithm.
- User identity is obtained from the verified token.
- User role and blocked status are always retrieved from MongoDB.
- Blocked users cannot access protected endpoints.
- Role-based middleware restricts access to authorized resources.

### Database

Database: `pizzahub`

Main collections include:
- users
- menuItems
- orders
- Stripe-related subscription and transaction records

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/me` | Get authenticated user |
| GET | `/api/health` | Check API and database status |

### Menu Items

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/menu-items` | Browse menu items |
| GET | `/api/menu-items/locations` | Get available locations |
| GET | `/api/menu-items/featured` | Get featured items |
| GET | `/api/menu-items/categories` | Get categories |
| GET | `/api/menu-items/:id` | Get menu item details |
| GET | `/api/menu-items/mine` | Get vendor's menu |
| POST | `/api/menu-items` | Create menu item |
| PATCH | `/api/menu-items/:id` | Update menu item |
| DELETE | `/api/menu-items/:id` | Delete menu item |

### Orders

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/orders` | Place an order |
| GET | `/api/orders/mine` | Get customer orders |
| PATCH | `/api/orders/mine/:id/cancel` | Cancel an order |
| GET | `/api/orders/vendor` | Get vendor orders |
| PATCH | `/api/orders/vendor/:id/status` | Update order status |

Pizza orders do not require online payment.

### Admin

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/overview` | Dashboard statistics |
| GET | `/api/admin/users` | Manage users |
| PATCH | `/api/admin/users/:id/block` | Block or unblock users |
| GET | `/api/admin/menu-items` | Manage menu items |
| PATCH | `/api/admin/menu-items/:id/status` | Update approval status |
| DELETE | `/api/admin/menu-items/:id` | Delete menu item |
| GET | `/api/admin/transactions` | View transactions |

### Payments and Subscriptions

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/payments/checkout` | Create vendor subscription checkout |
| GET | `/api/payments/session/:id` | Retrieve checkout session |
| POST | `/api/payments/webhook` | Process Stripe webhook events |

### Profile

| Method | Endpoint | Description |
|---|---|---|
| PATCH | `/api/profile` | Update authenticated user's profile |

Profile updates allow customers and vendors to update permitted personal information. Vendor business name is editable only by vendors. Role, blocked status, and subscription fields are protected.

## Stripe Subscription System

PizzaHub integrates Stripe for Vendor Premium subscriptions.

- Subscription price: $9.99 per month.
- Stripe Checkout uses subscription mode.
- Subscription price is configured on the server.
- Premium access is activated only after verified webhook processing.

Configured webhook events:

- `checkout.session.completed`
- `checkout.session.expired`
- `invoice.paid`
- `customer.subscription.deleted`

Pizza ordering itself does not use Stripe payments.

## Installation and Local Setup

### Prerequisites

- Node.js
- npm
- MongoDB Atlas account
- Stripe sandbox account
- PizzaHub client application

### 1. Clone repository

```bash
git clone https://github.com/iamminhaz31/pizzahub-server.git
cd pizzahub-server
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the server root directory.

Required environment variable names:

```env
PORT=
MONGODB_URI=
DB_NAME=
CLIENT_URL=
AUTH_URL=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

Use the appropriate values in your local environment. Never commit environment variable values or secrets to GitHub.

### 4. Start development server

```bash
npm run dev
```

The development server uses Node.js watch mode.

### 5. Start production server

```bash
npm start
```

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server with watch mode |
| `npm start` | Start production server |

## Deployment

The backend is deployed using Vercel.

**Production API:** https://pizzahub-server-lemon.vercel.app

The frontend communicates with this API through the configured client API URL.

MongoDB Atlas is used as the production database.

## Project Challenges

### 1. Advanced Search, Filtering and Sorting

Implemented menu discovery using MongoDB queries and aggregation-based filtering and sorting.

### 2. JWT Authentication and Database Role Verification

Implemented JWT verification using jose and Better Auth JWKS. User permissions and blocked status are verified against MongoDB.

### 3. Responsive UI and Application Polish

The backend supports the frontend's role-based features, menu operations, order workflows, and subscription management.

## Author

PizzaHub Project

Developed as an academic project.