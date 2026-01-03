# RentTrack Backend

Node.js + TypeScript backend for RentTrack application.

## Stack

- **Node.js** + **TypeScript**
- **Express** - Web framework
- **Prisma** - ORM for PostgreSQL
- **PostgreSQL** - Database
- **AWS Cognito** - Authentication
- **Stripe** - Payment processing (future)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required variables:
- `DATABASE_URL` - PostgreSQL connection string
- `COGNITO_USER_POOL_ID` - AWS Cognito user pool ID
- `COGNITO_CLIENT_ID` - Cognito app client ID
- `COGNITO_CLIENT_SECRET` - Cognito app client secret
- `AWS_REGION` - AWS region (e.g., us-east-1)
- `JWT_SECRET` - Secret for signing JWTs
- `FRONTEND_URL` - Frontend URL for CORS

### 3. Database Setup

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# (Optional) Open Prisma Studio
npm run prisma:studio
```

### 4. Run Development Server

```bash
npm run dev
```

Server will start on `http://localhost:3000`

## API Endpoints

### Authentication
- `POST /api/auth/signup-landlord` - Create landlord account
- `POST /api/auth/login` - Login (optional, frontend can call Cognito directly)
- `GET /api/auth/me` - Get current user

### Invites
- `GET /api/invites/:token` - Get invite details
- `POST /api/invites/:token/accept` - Accept invite and create account

### Properties
- `GET /api/properties` - List properties
- `POST /api/properties` - Create property
- `PATCH /api/properties/:id` - Update property
- `DELETE /api/properties/:id` - Delete property

### Units
- `GET /api/units` - List units
- `POST /api/units` - Create unit
- `PATCH /api/units/:id` - Update unit
- `DELETE /api/units/:id` - Delete unit

### Tenants
- `GET /api/tenants` - List tenant memberships
- `POST /api/tenants` - Create tenant + send invite
- `PATCH /api/tenants/:id` - Update tenant
- `DELETE /api/tenants/:id` - Remove tenant
- `POST /api/tenants/transfer` - Transfer tenant to new unit

### Payments
- `GET /api/payments` - List payments
- `POST /api/payments` - Record payment

## Database Schema

### Core Models

**User** - Login identity (can be both landlord and tenant)
- `cognitoId` - AWS Cognito user ID
- `email` - Unique email
- `name` - Full name

**LandlordAccount** - Landlord-specific data
- `userId` - FK to User
- `payoutsEnabled` - Stripe payouts enabled

**Property** - Rental property
- `landlordId` - FK to LandlordAccount
- `name`, `address`

**Unit** - Individual rental unit
- `propertyId` - FK to Property
- `rentAmount`, `dueDay`, `gracePeriodDays`

**TenantMembership** - Tenant-unit relationship (allows multi-unit tenants)
- `userId` - FK to User
- `unitId` - FK to Unit
- `landlordId` - For queries
- `inviteStatus` - PENDING | ACCEPTED
- `inviteToken` - Unique invite token
- `status` - ACTIVE | INACTIVE

**Payment** - Rent payment record
- `tenantMembershipId` - FK to TenantMembership
- `amount`, `method`, `date`, `month`

## Development

### Adding a New Migration

```bash
npm run prisma:migrate
```

### Viewing Database

```bash
npm run prisma:studio
```

### Build for Production

```bash
npm run build
npm start
```

## Architecture

```
src/
├── index.ts              # Express app entry point
├── lib/
│   └── prisma.ts         # Prisma client instance
├── middleware/
│   ├── auth.ts           # Cognito JWT verification
│   └── errorHandler.ts   # Global error handler
├── routes/
│   ├── auth.ts           # Authentication routes
│   ├── invites.ts        # Invite management
│   ├── properties.ts     # Property CRUD
│   ├── units.ts          # Unit CRUD
│   ├── tenants.ts        # Tenant management
│   └── payments.ts       # Payment tracking
└── services/
    └── cognito.ts        # AWS Cognito operations
```

## Notes

- All routes except auth and public invite endpoints require authentication
- Authentication uses Cognito ID tokens verified with `aws-jwt-verify`
- User/Membership model supports same email as both landlord and tenant
- Tenant can rent multiple units (multiple memberships)
