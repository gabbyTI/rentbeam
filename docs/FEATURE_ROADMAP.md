# RentBeam Feature Roadmap

## Current Version: v1.0 (Beta - January 2026)

---

## ✅ Phase 1: MVP - Core Rent Collection (COMPLETED)

**Status:** Live in Beta  
**Target:** Small landlords (1-20 units)

### Landlord Features
- [x] Property and unit management
- [x] Tenant invitation system via email
- [x] Stripe Connect onboarding for payouts
- [x] Manual payment recording (cash/check/Interac)
- [x] Online card payment acceptance
- [x] Autopay setup for tenants
- [x] Payment history and tracking
- [x] Basic dashboard analytics
- [x] Email notifications (payment received, failed payment)
- [x] Rent reminder emails (3 days before due)

### Tenant Features
- [x] Invitation acceptance flow
- [x] Secure account creation (AWS Cognito)
- [x] Card payment method setup
- [x] Autopay enable/disable
- [x] One-time manual rent payment
- [x] Payment history view
- [x] Email payment confirmations

### Technical
- [x] REST API (Node.js + TypeScript + Express)
- [x] PostgreSQL database (Prisma ORM)
- [x] AWS Cognito authentication
- [x] Stripe integration (payments + Connect)
- [x] AWS SES email delivery
- [x] Scheduled cron jobs (autopay processing, reminders)
- [x] Railway cloud deployment
- [x] Stateless architecture (horizontal scaling)

---

## 🔄 Phase 2: Production Readiness (IN PROGRESS)

**Timeline:** January - February 2026  
**Focus:** Stability, compliance, and user experience

### Landlord Enhancements
- [ ] Payment retry configuration (customize retry attempts)
- [ ] Export payment history to CSV
- [ ] Multi-property dashboard view
- [ ] Tenant payment method visibility
- [ ] Custom email templates (payment reminders)
- [ ] Payment receipt generation (PDF)
- [ ] Notification preferences (email frequency)
- [ ] Secondary notification email support

### Tenant Enhancements
- [ ] SMS payment reminders (opt-in)
- [ ] Mobile-responsive payment flow
- [ ] Payment calendar view (upcoming due dates)
- [ ] Update payment card in-app (not requiring re-setup)

### Business Operations
- [ ] AWS SES production access (remove sandbox mode)
- [ ] Domain email verification (noreply@rentbeam.ca)
- [ ] DKIM/SPF/DMARC setup (email deliverability)
- [ ] Terms of Service page
- [ ] Privacy Policy page
- [ ] Pricing page on website
- [ ] User onboarding guide/tooltips

### Technical
- [ ] Staging environment (separate Cognito pool)
- [ ] Production environment setup
- [ ] Automated backups (Neon PostgreSQL)
- [ ] Error monitoring (Sentry or similar)
- [ ] Performance monitoring (response times)
- [ ] API rate limiting
- [ ] Comprehensive logging
- [ ] Health check improvements

---

## 📊 Phase 3: Enhanced Analytics & Reporting

**Timeline:** March - April 2026  
**Focus:** Better financial insights for landlords

### Features
- [ ] Monthly revenue reports
- [ ] Year-over-year comparison
- [ ] Collection rate trends (autopay vs. manual)
- [ ] Late payment analytics
- [ ] Property performance comparison
- [ ] Rent roll report (all tenants, units, status)
- [ ] Export reports to PDF
- [ ] Export to QuickBooks/Xero format
- [ ] Autopay adoption metrics
- [ ] Payment method distribution graphs
- [ ] Overdue rent dashboard widget

### Nice-to-Haves
- [ ] Revenue forecast (based on historical data)
- [ ] Vacancy tracking
- [ ] Occupancy rate calculation

---

## ⚡ Phase 4: Automation & Late Fees

**Timeline:** May - June 2026  
**Focus:** Reduce landlord manual work

### Features
- [ ] Automated late fees
  - [ ] Configurable grace period
  - [ ] Flat fee or percentage
  - [ ] Auto-charge to tenant card
  - [ ] Waive late fee option
- [ ] Custom reminder schedules
  - [ ] 7 days before, 3 days before, day of, day after
  - [ ] Escalating reminders for overdue rent
- [ ] Lease renewal reminders
  - [ ] Alert 60/30 days before lease end
  - [ ] Track lease expiration dates
- [ ] Failed payment escalation
  - [ ] Retry 3 times over 7 days
  - [ ] Auto-email tenant after final failure
- [ ] Bulk actions
  - [ ] Bulk invite tenants
  - [ ] Bulk rent updates
  - [ ] Bulk email send

---

## 💬 Phase 5: Communication & Documents

**Timeline:** July - September 2026  
**Focus:** Centralize landlord-tenant communication

### Features
- [ ] In-app messaging
  - [ ] Landlord can message tenants
  - [ ] Tenants can message landlords
  - [ ] Email notifications for new messages
- [ ] Maintenance request system
  - [ ] Tenants submit requests with photos
  - [ ] Landlords track status (open/in-progress/closed)
  - [ ] Priority levels
- [ ] Document storage
  - [ ] Upload/store lease agreements
  - [ ] Store payment receipts
  - [ ] W-9 forms, tax documents
- [ ] E-signature integration (DocuSign/HelloSign)
  - [ ] Sign leases digitally
  - [ ] Store signed copies

---

## 🏢 Phase 6: Advanced Features & Scale

**Timeline:** Q4 2026  
**Focus:** Serve medium-to-large landlords (50-200 units)

### Multi-User Support
- [ ] Property manager accounts
  - [ ] Manage properties on behalf of multiple landlords
  - [ ] Separate financial accounts per landlord
- [ ] Team roles (assistant property manager)
- [ ] Granular permissions (read-only, financial access, etc.)

### Payment Features
- [ ] ACH/bank transfer payments (lower fees via Plaid)
- [ ] Split rent between roommates
- [ ] Partial payments (pay half now, half later)
- [ ] Payment plans for late rent
- [ ] Security deposit tracking
- [ ] Utility bill split (optional add-on)

### Tenant Features
- [ ] Tenant portal improvements
  - [ ] View lease agreement
  - [ ] Download tax receipts
  - [ ] Update emergency contacts
- [ ] Autopay pause/resume (e.g., during vacation)
- [ ] Payment method switching (card ↔ bank account)

### Analytics
- [ ] Cash flow projections
- [ ] Tax reporting (annual 1099 generation)
- [ ] Expense tracking (maintenance, utilities, etc.)
- [ ] Profit & loss statements per property

---

## 🌍 Phase 7: Enterprise & White-Label

**Timeline:** 2027  
**Focus:** Serve property management companies (200+ units)

### Enterprise Features
- [ ] White-label platform
  - [ ] Custom domain (rentals.yourcompany.com)
  - [ ] Custom branding (logo, colors)
  - [ ] Remove RentBeam branding
- [ ] API access for third-party integrations
- [ ] SSO (Single Sign-On) for property managers
- [ ] Multi-currency support (CAD, USD)
- [ ] Multi-language support (English, French, Spanish)
- [ ] Dedicated account manager
- [ ] Priority support SLA
- [ ] Custom reporting

### Platform
- [ ] Mobile apps (iOS/Android native apps)
- [ ] Offline mode (view data without internet)
- [ ] Advanced security (2FA, IP whitelisting)

---

## 🔮 Future Considerations (Not Scheduled)

### Features Under Review
- [ ] Rent bidding/marketplace (tenants bid on available units)
- [ ] Tenant credit checks (via Equifax/TransUnion API)
- [ ] Rental insurance integration
- [ ] Smart lock integration (grant access remotely)
- [ ] Showing scheduler (book property viewings)
- [ ] Tenant screening reports
- [ ] Background checks
- [ ] Eviction tracking
- [ ] Co-signer support
- [ ] International wire transfers
- [ ] Crypto payment support (Bitcoin, USDC)

---

## How We Prioritize

### Decision Framework
1. **User Requests** - What landlords and tenants ask for most
2. **Market Gaps** - Features competitors don't offer well
3. **Revenue Impact** - Features that increase online payment adoption
4. **Technical Feasibility** - Can we build it reliably?
5. **Compliance** - Legal/regulatory requirements

### Request a Feature
Vote on features or suggest new ones:
- Email: feedback@rentbeam.ca
- Subject: "Feature Request: [Your Idea]"

---

## Version History

### v1.0 (January 2026) - Beta Launch
- Core rent collection platform
- Landlord and tenant authentication
- Stripe payment processing
- Email notifications
- Basic dashboard

### v0.9 (December 2025) - Alpha Testing
- Internal testing with 5 landlords
- Bug fixes and UX improvements

### v0.5 (November 2025) - Development
- Initial prototype with mock data

---

## Release Schedule

- **Minor updates (bug fixes):** Weekly
- **Feature releases:** Monthly
- **Major versions:** Quarterly

---

*This roadmap is a living document and subject to change based on user feedback, market conditions, and technical considerations.*

*Last Updated: January 2026*
