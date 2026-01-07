# RentBeam - Project Context & Backend Architecture

## App Overview

RentBeam is a property management application that enables landlords to manage properties, units, and tenants while allowing tenants to track and pay rent. The application supports multi-property tenant relationships, meaning a single user can be a tenant at multiple properties simultaneously.

## Core Features

- **Landlord Management**: Property and unit management, tenant invitations, payment tracking
- **Tenant Management**: View rent due dates, make payments, track payment history
- **Invite System**: Email-based tenant invitations with password setup
- **Grace Period Tracking**: Configurable grace periods per unit
- **Payment Tracking**: Manual and autopay payment recording
- **Multi-Property Support**: Users can be tenants at multiple properties

## Tech Stack

### Backend
- **Runtime**: Node.js (v25+)
- **Language**: TypeScript (ES2022, CommonJS)
- **Framework**: Express 5.2.1
- **Database**: PostgreSQL (with Prisma Postgres for development)
- **ORM**: Prisma 7.2.0 (with new config format)
- **Authentication**: AWS Cognito (JWT token verification)
- **Payment Processing**: Stripe (future integration)

### Key Dependencies
- `aws-sdk/client-cognito-identity-provider` - Cognito operations
- `aws-jwt-verify` - JWT token verification
- `express`, `cors`, `dotenv`
- `bcryptjs`, `jsonwebtoken`
- `tsx` - Development server with hot reload

## Architecture Decisions

### 1. User/Membership Model (NOT Tenant Model)

**Why?** A single email can be a tenant at multiple properties.

- **User Table**: Central user identity (email unique, cognitoId)
- **LandlordAccount Table**: One per user who is a landlord
- **TenantMembership Table**: Junction table linking users to units (allows multiple memberships per user)

This design allows:
- Same user to be a landlord AND tenant
- Same email to rent multiple units across different properties
- Clean separation of identity vs. roles

### 2. Unit-Level Rent Configuration

**Rent amount and due day are stored at the Unit level** as the source of truth.

- When creating a TenantMembership, rent amount is copied from Unit
- This allows historical tracking if unit rent changes later
- Each unit has: `rentAmount`, `dueDay`, `gracePeriodDays`

### 3. Authentication Flow

**Frontend → Cognito → Backend**

1. **Signup (Landlord)**: 
   - Frontend → Backend `/api/auth/signup-landlord`
   - Backend creates User + LandlordAccount + Cognito user
   - Returns success, frontend redirects to login

2. **Login**: 
   - Frontend → Cognito directly (AWS Amplify SDK)
   - Cognito returns ID token
   - Frontend includes token in `Authorization: Bearer <token>` header
   - Backend validates token with `aws-jwt-verify`

3. **Tenant Invite Flow**:
   - Landlord creates tenant → Backend generates invite token
   - Backend creates User (if needed) + TenantMembership (PENDING status)
   - Tenant visits invite link → Enters password
   - Frontend → Backend `/api/invites/:token/accept` with password
   - Backend creates Cognito user + updates membership to ACCEPTED
   - Edge case: If same email has multiple invites, only creates Cognito user once

## Database Schema

### Table Names (Plural with snake_case)
- `users`
- `landlord_accounts`
- `properties`
- `units`
- `tenant_memberships`
- `payments`

### Key Models

```prisma
model User {
  id        String   @id @default(uuid())
  cognitoId String?  @unique // null until Cognito account created
  email     String   @unique
  name      String
  phone     String?
  
  landlordAccount   LandlordAccount?
  tenantMemberships TenantMembership[]
  
  @@map("users")
}

model LandlordAccount {
  userId          String   @unique
  payoutsEnabled  Boolean  @default(false)
  stripeAccountId String?
  
  properties Property[]
  
  @@map("landlord_accounts")
}

model Property {
  landlordId String
  name       String
  address    String
  
  units Unit[]
  
  @@map("properties")
}

model Unit {
  propertyId      String
  name            String
  rentAmount      Decimal  @db.Decimal(10, 2)
  dueDay          Int      // 1-31
  gracePeriodDays Int      @default(5)
  
  tenantMemberships TenantMembership[]
  
  @@map("units")
}

model TenantMembership {
  userId     String
  unitId     String
  landlordId String
  
  rentAmount  Decimal   @db.Decimal(10, 2) // Snapshot from Unit
  moveInDate  DateTime
  moveOutDate DateTime?
  
  inviteStatus InviteStatus @default(PENDING) // PENDING | ACCEPTED
  inviteToken  String?      @unique
  
  status MembershipStatus @default(ACTIVE) // ACTIVE | INACTIVE
  
  autopayEnabled     Boolean @default(false)
  stripeCustomerId   String?
  paymentMethodLabel String?
  
  payments Payment[]
  
  @@map("tenant_memberships")
}

model Payment {
  tenantMembershipId String
  amount    Decimal       @db.Decimal(10, 2)
  method    PaymentMethod // AUTOPAY | MANUAL
  date      DateTime
  month     String        // Format: "2025-01"
  note      String?
  
  @@map("payments")
}
```

### Enums
- `InviteStatus`: PENDING, ACCEPTED
- `MembershipStatus`: ACTIVE, INACTIVE
- `PaymentMethod`: AUTOPAY, MANUAL

## API Routes

### Authentication (`/api/auth`)
- `POST /signup-landlord` - Create landlord account + Cognito user
- `POST /login` - Optional backend login endpoint
- `GET /me` - Get current user info

### Invites (`/api/invites`)
- `GET /:token` - Get invite details (for password setup page)
- `POST /:token/accept` - Accept invite + set password (creates Cognito user)

### Properties (`/api/properties`)
- `GET /` - List landlord's properties
- `POST /` - Create property
- `PATCH /:id` - Update property
- `DELETE /:id` - Delete property (cascades to units)

### Units (`/api/units`)
- `GET /` - List units for landlord
- `POST /` - Create unit
- `PATCH /:id` - Update unit
- `DELETE /:id` - Delete unit

### Tenants (`/api/tenants`)
- `GET /` - List tenant memberships
- `POST /` - Create tenant + membership (generates invite)
- `PATCH /:id` - Update membership
- `DELETE /:id` - Delete membership
- `POST /transfer` - Transfer tenant to new unit

### Payments (`/api/payments`)
- `GET /` - List payments (filtered by role: landlord sees all, tenant sees own)
- `POST /` - Record payment

## Authentication Middleware

**Location**: `src/middleware/auth.ts`

```typescript
export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  // 1. Extract Bearer token
  // 2. Verify with Cognito using aws-jwt-verify
  // 3. Extract email from token
  // 4. Look up user in database
  // 5. Attach user to req.user
  // 6. Call next()
}
```

## Environment Variables

```env
# Database
DATABASE_URL="postgresql://postgres:password@10.0.0.107:5432/rentbeam"

# AWS Cognito
COGNITO_USER_POOL_ID="your-user-pool-id"
COGNITO_CLIENT_ID="your-client-id"
COGNITO_CLIENT_SECRET="your-client-secret"
AWS_REGION="us-east-1"

# JWT Secret (for additional backend tokens if needed)
JWT_SECRET="dev-secret-key-change-in-production"

# Stripe (for future payment processing)
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."

# Server
PORT=3000
NODE_ENV=development
FRONTEND_URL="http://localhost:5173"
```

## Cognito Configuration

### User Pool Settings
- **Sign-in**: Email only
- **Password Policy**: Minimum 8 characters
- **MFA**: Optional (can be required later)
- **Required Attributes**: email, name, phone_number
- **App Client**: With client secret enabled

### User Creation Flow
```typescript
// Backend creates users with AdminCreateUser
// Then sets permanent password with AdminSetUserPassword
// This bypasses the temporary password email flow
```

## Key Design Patterns

### 1. Invite Token Generation
```typescript
const inviteToken = crypto.randomBytes(32).toString('hex');
```

### 2. Cascading Deletes
- Delete Property → Delete Units → Delete TenantMemberships → Delete Payments
- All configured via Prisma `onDelete: Cascade`

### 3. Payment Window Logic (Frontend)
- **Within Grace Period**: Payment window OPEN
- **After Grace Period**: Payment window CLOSED
- Grace period starts at midnight on due day

### 4. Rent Month Display
- Format: "January 2025", "February 2025"
- Helps users understand which month they're paying for

### 5. Transfer Tenant Feature
- Marks old membership as INACTIVE (preserves payment history)
- Creates new membership as ACTIVE with new unit details

## Prisma 7 Considerations

### New Config Format
Prisma 7 introduced `prisma.config.ts` instead of embedding config in `schema.prisma`:

```typescript
// prisma.config.ts
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] },
  client: { engineType: "library" }, // Important!
});
```

### Engine Type
Must specify `engineType: "library"` in both:
1. `prisma.config.ts` → `client.engineType`
2. `schema.prisma` → `generator client { engineType = "library" }`

Otherwise you'll get: `PrismaClientConstructorValidationError: Using engine type "client" requires either "adapter" or "accelerateUrl"`

## Development Workflow

### Initial Setup
```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev  # Starts on port 3000
```

### Database Changes
```bash
# Edit prisma/schema.prisma
npx prisma migrate dev --name description_of_change
npx prisma generate
```

### Development Server
```bash
npm run dev  # Uses tsx watch for hot reload
```

### Production Build
```bash
npm run build  # Compiles TypeScript to dist/
npm start      # Runs compiled JavaScript
```

## Frontend Integration Plan

### Phase 1: Update Types
- Replace `Tenant` with `User + TenantMembership`
- Update all components to use new data structure

### Phase 2: AWS Amplify Setup
```bash
npm install aws-amplify @aws-amplify/ui-react
```

Configure Amplify with Cognito user pool credentials.

### Phase 3: API Integration
- Replace mock data with real API calls
- Use `services/api.ts` (already created with axios)
- Add Authorization header with Cognito token

### Phase 4: Authentication UI
- Login page → Cognito login → Store token
- Signup page → Backend signup endpoint
- Protected routes → Check for valid token

## Testing Strategy

### Manual Testing Endpoints
```bash
# Health check
curl http://localhost:3000/health

# Signup landlord
curl -X POST http://localhost:3000/api/auth/signup-landlord \
  -H "Content-Type: application/json" \
  -d '{"email":"landlord@test.com","password":"Test1234!","name":"John Doe"}'

# Get invite details
curl http://localhost:3000/api/invites/<token>

# Accept invite
curl -X POST http://localhost:3000/api/invites/<token>/accept \
  -H "Content-Type: application/json" \
  -d '{"password":"Test1234!"}'
```

### Authenticated Requests
```bash
curl http://localhost:3000/api/properties \
  -H "Authorization: Bearer <cognito-id-token>"
```

## Future Enhancements

1. **Stripe Integration**: Autopay with saved payment methods
2. **Email Notifications**: Rent reminders, payment confirmations
3. **Payment Analytics**: Dashboard for landlords
4. **Document Storage**: Lease agreements, receipts
5. **Maintenance Requests**: Tenant-to-landlord communication
6. **Multi-tenancy**: Multiple tenants per unit (roommates)
7. **Rent History**: Track rent increases over time
8. **Late Fees**: Automatic calculation after grace period

## Common Issues & Solutions

### Issue: "PrismaClientConstructorValidationError"
**Solution**: Ensure `engineType: "library"` in both `prisma.config.ts` and `schema.prisma`

### Issue: Database authentication failed
**Solution**: Verify DATABASE_URL credentials, ensure PostgreSQL is running

### Issue: "Cannot find Prisma Schema"
**Solution**: Run commands from backend directory or use `--config backend/prisma.config.ts`

### Issue: Cognito user creation fails
**Solution**: Check COGNITO_CLIENT_SECRET is correctly configured, verify user pool settings

## Project Status

✅ Backend infrastructure complete
✅ Database schema designed and migrated
✅ Authentication middleware implemented
✅ All CRUD routes created
✅ Invite flow implemented
✅ Prisma client configured
🔄 Cognito setup pending (user needs to create user pool)
🔄 Frontend integration pending
🔄 End-to-end testing pending

---

**Last Updated**: December 30, 2025
**Backend Version**: 1.0.0
**Prisma Version**: 7.2.0
