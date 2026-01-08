# RentBeam - Feature Overview

## Product Description

RentBeam is a modern rent collection platform designed for small-to-medium landlords managing 1-50 rental units. We simplify rent collection through automated payments, digital invitations, and real-time payment tracking.

---

## Core Features

### 🏠 For Landlords

#### Property & Unit Management
- **Multi-Property Support** - Manage multiple properties from one dashboard
- **Unit Organization** - Create and track individual rental units per property
- **Rent Configuration** - Set rent amount, due date, and autopay eligibility per unit
- **Online Payment Toggle** - Enable/disable online payments per property

#### Tenant Management
- **Email Invitations** - Invite tenants via email with secure one-time links
- **Tenant Onboarding** - Guided signup flow for invited tenants
- **Tenant Directory** - View all active tenants across properties
- **Payment Method Visibility** - See which tenants have autopay enabled
- **Tenant Details** - Track contact info, unit assignment, and payment history

#### Payment Collection
- **Stripe Integration** - Accept credit/debit card payments online
- **Autopay Processing** - Automatic rent charges on due dates
- **Manual Payment Recording** - Mark cash/check/Interac payments as received
- **Payment Status Tracking** - Real-time view of paid/pending/overdue rent
- **Payment History** - Complete transaction records with timestamps
- **Retry Logic** - Automatic retry for failed autopay transactions

#### Analytics & Reporting
- **Dashboard Overview** - Quick stats on collection rate, total rent, overdue amounts
- **Payment Method Analytics** - See autopay vs manual payment distribution
- **Revenue Tracking** - Monthly income reporting
- **Late Payment Alerts** - Identify overdue tenants at a glance

#### Financial Management
- **Stripe Connect** - Receive funds directly to your bank account
- **Connected Account Setup** - Onboard to Stripe with KYC verification
- **Payout Management** - View Stripe balance and payout schedule
- **Transaction Fees** - Transparent Stripe fee display (2.9% + $0.30 per transaction)

#### Communication
- **Automated Email Notifications** - Payment confirmations, reminders, failed payment alerts
- **Customizable Reminders** - Set reminder schedules before rent is due
- **Notification Email Management** - Add secondary email for landlord notifications

---

### 🏘️ For Tenants

#### Onboarding
- **Invite Acceptance** - Accept landlord invitation via secure link
- **Profile Setup** - Create account with name, email, phone, password
- **Property Assignment** - Automatic unit and rent details from invitation

#### Payment Methods
- **Card Autopay** - Save credit/debit card for automatic monthly charges
- **Manual Payment Option** - Pay via Interac e-Transfer, cash, or check
- **Payment Method Management** - Update or remove saved cards
- **Autopay Toggle** - Enable/disable autopay anytime

#### Payment Experience
- **One-Click Payments** - Pay rent instantly with saved card
- **Payment Confirmation** - Immediate email receipt after payment
- **Payment History** - View all past rent payments and methods
- **Due Date Reminders** - Email notifications before rent is due

#### Account Management
- **Secure Authentication** - AWS Cognito-powered login with MFA support
- **Profile Updates** - Edit contact information and password
- **Dashboard View** - See rent status, next due date, payment history
- **Email Verification** - Two-factor email verification for account changes

---

## Technical Features (Backend)

### Security & Authentication
- **AWS Cognito Integration** - Enterprise-grade user authentication
- **JWT Token Authentication** - Secure API access
- **Role-Based Access Control** - Separate landlord/tenant permissions
- **OTP Verification** - One-time passwords for sensitive operations
- **Encrypted Passwords** - Cognito-managed password hashing

### Payment Processing
- **Stripe API v2025** - Latest payment processing capabilities
- **PCI Compliance** - Stripe handles all card data securely
- **Webhook Handling** - Real-time payment status updates
- **Idempotency** - Prevent duplicate charges
- **Autopay Retry Logic** - Configurable retry attempts for failed payments

### Infrastructure
- **Stateless Architecture** - Horizontally scalable across multiple instances
- **PostgreSQL Database** - Reliable relational data storage via Neon
- **Prisma ORM** - Type-safe database queries
- **Railway Deployment** - Cloud hosting with auto-scaling
- **AWS SES** - Transactional email delivery

### Automation
- **Scheduled Jobs** - Cron-based autopay processing and reminders
- **Email Queue** - Async email delivery system
- **Payment Retry System** - Automatic retry for failed autopay
- **Reminder System** - Configurable pre-due date notifications

### Developer Experience
- **TypeScript** - Full type safety across frontend and backend
- **API Documentation** - Complete REST API reference
- **Error Handling** - Standardized error responses
- **Logging & Monitoring** - Winston-based structured logging
- **Health Checks** - Uptime monitoring endpoints

---

## Upcoming Features (Roadmap)

### Phase 2 - Enhanced Analytics
- Landlord profit/loss reports
- Export to CSV/PDF
- Multi-year trend analysis
- Property performance comparison

### Phase 3 - Advanced Automation
- Late fee automation
- Lease renewal reminders
- Maintenance request system
- Document storage (leases, receipts)

### Phase 4 - Tenant Features
- Split rent between roommates
- Partial payment support
- Payment plan negotiation
- In-app messaging with landlords

### Phase 5 - Scale & Enterprise
- Property manager support (managing for multiple landlords)
- White-label option for property management companies
- API access for third-party integrations
- Mobile apps (iOS/Android)

---

## Integrations

### Current
- **Stripe** - Payment processing and payouts
- **AWS Cognito** - User authentication
- **AWS SES** - Transactional emails
- **Neon PostgreSQL** - Serverless database

### Planned
- **Plaid** - Bank account verification for ACH payments
- **QuickBooks/Xero** - Accounting software sync
- **DocuSign** - Lease agreement signing
- **Twilio** - SMS notifications

---

## Platform Capabilities

- **Multi-Tenancy** - Separate data isolation per landlord
- **Real-Time Updates** - Webhook-driven status changes
- **Audit Trail** - Complete payment history logging
- **Data Export** - Export payment records
- **Responsive Design** - Works on desktop, tablet, mobile
- **Browser Compatibility** - Chrome, Firefox, Safari, Edge

---

## Compliance & Legal

- **PCI DSS Compliance** - Via Stripe (we never touch card data)
- **GDPR Ready** - Data privacy controls
- **SOC 2 Infrastructure** - AWS and Stripe compliance
- **Terms of Service** - User agreements in place
- **Privacy Policy** - Transparent data handling

---

*Last Updated: January 2026*
