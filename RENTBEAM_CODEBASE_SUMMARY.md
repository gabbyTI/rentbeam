# RentBeam SaaS Application - Codebase Analysis Summary

## Overview
RentBeam is a comprehensive rent collection and property management SaaS platform designed for small to medium landlords (1-200+ units). The application facilitates automated rent collection, tenant management, and provides analytics for landlords while offering a streamlined payment experience for tenants.

## Architecture

### Backend (RentTrack-API)
**Technology Stack:**
- **Runtime:** Node.js with TypeScript
- **Framework:** Express.js
- **Database:** PostgreSQL with Prisma ORM
- **Authentication:** AWS Cognito (JWT-based)
- **Payments:** Stripe Connect + Payment Intents
- **Email:** AWS SES (via nodemailer)
- **Monitoring:** Prometheus metrics, Pino logging
- **Deployment:** Railway (cloud platform)
- **Scheduling:** node-cron for automated jobs

**Key Features:**
- RESTful API with comprehensive error handling
- Automated payment processing via Stripe
- Email notifications and reminders
- Cron jobs for autopay and payment reminders
- Webhook handling for Stripe events
- Multi-tenant architecture with landlord/tenant roles

### Frontend (RentTrack)
**Technology Stack:**
- **Framework:** React 18 with TypeScript
- **Routing:** React Router v6
- **Styling:** Tailwind CSS
- **Build Tool:** Vite
- **Payments:** Stripe React components
- **State Management:** React Context API
- **Storage:** localStorage for session persistence

**Key Features:**
- Responsive design (mobile-first)
- Role-based routing (landlord/tenant)
- Real-time payment processing
- Dashboard analytics and reporting
- Stripe payment method management

## Core Business Model

### User Roles
1. **Landlords** - Property owners who collect rent
2. **Tenants** - Renters who pay monthly rent

### Revenue Model
- **Processing Fees:** 2.9% + $0.30 per online card payment (charged to tenant)
- **Stripe Connect:** Facilitates payouts to landlord bank accounts
- **No monthly subscription fees** (transaction-based revenue)

## Database Schema

### Core Entities
```
User (Authentication & Profile)
├── LandlordAccount (1:1) - Landlord-specific data
│   └── Properties (1:N)
│       └── Units (1:N)
│           └── TenantMemberships (1:N)
│               └── Payments (1:N)
└── TenantMemberships (1:N) - Can be tenant of multiple units
    └── Payments (1:N)
```

### Key Models
- **User:** Core identity (email, name, phone, Cognito ID)
- **LandlordAccount:** Stripe account, payout settings, defaults
- **Property:** Real estate properties with address
- **Unit:** Individual rental units with rent amount, due day
- **TenantMembership:** Tenant-unit relationship with autopay settings
- **Payment:** Rent payment records with Stripe integration
- **OtpVerification:** Email verification system

## Payment Processing Flow

### Autopay System
1. **Daily Cron Job** runs to find tenants with rent due today
2. **Stripe Payment Intent** created with saved payment method
3. **Success:** Payment recorded, landlord notified, payout initiated
4. **Failure:** Retry logic, failure count tracking, autopay disable after 3 failures
5. **Email Notifications** sent for all payment events

### Manual Payments
1. **Landlord** marks payment as received in dashboard
2. **Payment Record** created with "MANUAL" method
3. **Tenant** sees updated status in their dashboard

### Payment Method Management
1. **Stripe SetupIntent** for secure card storage
2. **Customer/PaymentMethod** relationship in Stripe
3. **PCI Compliance** handled by Stripe (no card data stored)

## Key Features Analysis

### Landlord Experience
**Dashboard Analytics:**
- Occupancy rates and revenue metrics
- Payment status tracking (Paid/Pending/Late)
- Outstanding balance monitoring
- Recent activity feed
- Property-grouped tenant views

**Property Management:**
- Multi-property support
- Unit creation with custom rent amounts and due dates
- Grace period configuration
- Online payment toggle per property

**Tenant Management:**
- Email-based invitation system
- Tenant status tracking (Active/Inactive/Pending)
- Move-in/move-out date tracking
- Tenant transfer between units
- Payment method visibility

**Payment Tracking:**
- Manual payment recording
- Payment history with filtering
- Autopay status monitoring
- Failed payment notifications

### Tenant Experience
**Dashboard:**
- Current rent status with visual indicators
- Payment history and analytics
- Year-to-date cost summaries
- Payment streak tracking
- On-time payment rate

**Payment Options:**
- One-time card payments
- Autopay setup/management
- Payment method updates
- Processing fee transparency

**Autopay Management:**
- Enable/disable autopay
- Payment method selection
- Failure handling and notifications
- Grace period awareness

## Security & Compliance

### Authentication
- **AWS Cognito** for user management
- **JWT tokens** for API authentication
- **Password reset** and email verification flows
- **Session management** with token refresh

### Payment Security
- **Stripe PCI Compliance** - no card data stored locally
- **Payment Method Tokenization** via Stripe
- **Webhook Signature Verification** for Stripe events
- **Off-session payments** for autopay

### Data Protection
- **Input validation** and sanitization
- **SQL injection protection** via Prisma ORM
- **Error handling** without data leakage
- **Rate limiting** on sensitive endpoints

## Automation & Scheduling

### Cron Jobs
1. **Autopay Processing** (Daily)
   - Finds tenants with rent due today
   - Processes Stripe payments
   - Handles failures and retries
   - Updates payment records

2. **Payment Reminders** (Daily)
   - Sends emails 3 days before due date
   - Only for properties accepting online payments
   - Skips tenants who already paid

### Email Notifications
- **Payment confirmations** (tenant & landlord)
- **Payment failures** with retry information
- **Autopay disabled** notifications
- **Payment reminders** before due date
- **Notification email verification** system

## Analytics & Reporting

### Landlord Analytics
- **Occupancy Metrics:** Rate, occupied/total units, vacancy tracking
- **Revenue Metrics:** Collected vs expected, collection rates
- **Outstanding Balance:** Amount and tenant count
- **Payment Status:** Paid/Pending/Late/Unpaid counts
- **Tenant Metrics:** Total active, autopay adoption, pending invites
- **Recent Activity:** Payment timeline and status changes

### Tenant Analytics
- **Payment Summary:** On-time rate, payment streaks
- **Year-to-Date:** Total rent, fees, monthly averages
- **Payment Timeline:** Visual history with status indicators
- **Cost Breakdown:** Rent vs processing fees

## Integration Points

### Stripe Integration
- **Connect Accounts** for landlord payouts
- **Payment Intents** for rent collection
- **Setup Intents** for payment method storage
- **Webhooks** for payment status updates
- **Customer Management** for tenant payment methods

### AWS Services
- **Cognito** for authentication and user management
- **SES** for transactional email delivery
- **JWT Verify** for token validation

## Scalability Considerations

### Backend Architecture
- **Stateless design** for horizontal scaling
- **Database connection pooling** via Prisma
- **Prometheus metrics** for monitoring
- **Structured logging** with Pino
- **Error tracking** and health checks

### Frontend Architecture
- **Component-based** React architecture
- **Context API** for state management
- **Lazy loading** and code splitting potential
- **Responsive design** for mobile/desktop

## Development Workflow

### Backend Development
- **TypeScript** for type safety
- **Prisma migrations** for database changes
- **Environment-based configuration**
- **Comprehensive error handling**
- **API documentation** and testing

### Frontend Development
- **Vite** for fast development builds
- **TypeScript** throughout the application
- **Tailwind CSS** for consistent styling
- **Component library** for reusable UI elements

## Deployment & Operations

### Production Setup
- **Railway** cloud deployment for backend
- **Environment variables** for configuration
- **Database migrations** on deployment
- **Health check endpoints** for monitoring
- **Graceful shutdown** handling

### Monitoring & Observability
- **Prometheus metrics** for performance tracking
- **Structured logging** for debugging
- **Error boundaries** in React components
- **Payment failure tracking** and alerting

## Business Logic Insights

### Payment Status Logic
- **Paid:** Payment exists for current month
- **Pending:** Due date hasn't passed, no payment
- **Due:** Due date passed, within grace period
- **Late:** Beyond grace period, no payment

### Autopay Failure Handling
- **3-strike system:** Disable after 3 consecutive failures
- **Failure reasons:** Card declined, insufficient funds, authentication required
- **Recovery:** Reset failure count on successful payment
- **Notifications:** Email alerts for each failure and final disable

### Tenant Lifecycle
- **Invitation:** Email-based with unique tokens
- **Registration:** Password setup and profile completion
- **Active:** Normal rent payment cycle
- **Move-out:** Status change with outstanding balance check
- **Transfer:** Move tenant between units with new invitation

This analysis reveals RentBeam as a sophisticated, production-ready SaaS platform with comprehensive payment processing, user management, and business analytics capabilities designed specifically for the rental property management market.