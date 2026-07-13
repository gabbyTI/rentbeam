/**
 * tests/routes/tenants.test.ts
 *
 * Focused tests for tenant creation in ledger-first mode.
 */

import request from 'supertest';
import express from 'express';
import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

const mockUser = { id: 'user-landlord-1', email: 'landlord@test.com', name: 'Test Landlord' };

jest.mock('../../src/middleware/auth.js', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = mockUser;
    next();
  },
}));

jest.mock('../../src/lib/prisma.js', () => {
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

jest.mock('../../src/lib/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockSendTenantInvite = jest.fn();
jest.mock('../../src/services/email.js', () => ({
  emailService: {
    sendTenantInvite: (...args: any[]) => mockSendTenantInvite(...args),
  },
}));

jest.mock('../../src/services/cognito.js', () => ({
  cognitoService: {
    deleteUser: jest.fn(),
  },
}));

const mockInvitesInc = jest.fn();
const mockUpdateTenantMetrics = jest.fn();
jest.mock('../../src/lib/metrics.js', () => ({
  invitesTotal: { inc: (...args: any[]) => mockInvitesInc(...args) },
  updateTenantMetrics: (...args: any[]) => mockUpdateTenantMetrics(...args),
}));

const mockPostCharge = jest.fn();
const mockPostCredit = jest.fn();
const mockPostPayment = jest.fn();
const mockGetCurrentBalance = jest.fn();
jest.mock('../../src/services/ledger.js', () => ({
  postCharge: (...args: any[]) => mockPostCharge(...args),
  postCredit: (...args: any[]) => mockPostCredit(...args),
  postPayment: (...args: any[]) => mockPostPayment(...args),
  getCurrentBalance: (...args: any[]) => mockGetCurrentBalance(...args),
}));

import prismaMock_ from '../../src/lib/prisma.js';
const prismaMock = prismaMock_ as unknown as DeepMockProxy<PrismaClient>;
import tenantRoutes from '../../src/routes/tenants.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tenants', tenantRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

function mockCreateHappyPath() {
  prismaMock.landlordAccount.findUnique.mockResolvedValue({
    id: 'landlord-1',
    userId: mockUser.id,
    user: { country: 'US' },
  } as any);

  prismaMock.unit.findUnique.mockResolvedValue({
    id: 'unit-1',
    rentAmount: 1000,
    dueDay: 1,
    property: { landlordId: 'landlord-1' },
  } as any);

  prismaMock.tenantMembership.findFirst
    .mockResolvedValueOnce(null) // unit active tenant check
    .mockResolvedValueOnce(null); // existing membership for existing user

  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.user.create.mockResolvedValue({
    id: 'tenant-user-1',
    email: 'tenant@example.com',
    name: 'John Doe',
  } as any);

  prismaMock.tenantMembership.create.mockResolvedValue({
    id: 'membership-1',
    userId: 'tenant-user-1',
    unitId: 'unit-1',
    landlordId: 'landlord-1',
    moveInDate: new Date('2026-07-12T12:00:00.000Z'),
    inviteStatus: 'PENDING',
    user: { id: 'tenant-user-1', email: 'tenant@example.com', name: 'John Doe' },
    unit: { id: 'unit-1' },
  } as any);

  mockSendTenantInvite.mockResolvedValue(undefined);
  mockUpdateTenantMetrics.mockResolvedValue(undefined);
  mockGetCurrentBalance.mockResolvedValue(0);
}

beforeEach(() => {
  const { mockReset } = require('jest-mock-extended');
  mockReset(prismaMock);
  mockSendTenantInvite.mockReset();
  mockInvitesInc.mockReset();
  mockUpdateTenantMetrics.mockReset();
  mockPostCharge.mockReset();
  mockPostCredit.mockReset();
  mockPostPayment.mockReset();
  mockGetCurrentBalance.mockReset();
});

describe('POST /api/tenants', () => {
  it('does not create a synthetic initial payment row', async () => {
    mockCreateHappyPath();

    const res = await request(buildApp())
      .post('/api/tenants')
      .send({
        email: 'tenant@example.com',
        firstName: 'John',
        lastName: 'Doe',
        unitId: 'unit-1',
        moveInDate: '2026-07-12',
      });

    expect(res.status).toBe(201);
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(mockPostCharge).not.toHaveBeenCalled();
    expect(mockPostCredit).not.toHaveBeenCalled();
    expect(mockPostPayment).not.toHaveBeenCalled();
    expect(res.body.data.openingLedgerEntriesPosted).toBe(0);
    expect(res.body.data.openingBalance).toBe(0);
  });

  it('posts optional opening ledger entries in CHARGE -> CREDIT -> PAYMENT order', async () => {
    mockCreateHappyPath();
    mockPostCharge.mockResolvedValue({ id: 'lc-1' });
    mockPostCredit.mockResolvedValue({ id: 'lc-2' });
    mockPostPayment.mockResolvedValue({ id: 'lp-1' });
    mockGetCurrentBalance.mockResolvedValue(650);

    const res = await request(buildApp())
      .post('/api/tenants')
      .send({
        email: 'tenant@example.com',
        firstName: 'John',
        lastName: 'Doe',
        unitId: 'unit-1',
        moveInDate: '2026-07-12',
        openingLedgerEntries: [
          { type: 'PAYMENT', amount: 200, description: 'Already paid cash' },
          { type: 'CHARGE', amount: 1000, code: 'RNTA', description: 'Opening Rent' },
          { type: 'CREDIT', amount: 150, code: 'CONC', description: 'Opening Concession' },
        ],
      });

    expect(res.status).toBe(201);
    expect(mockPostCharge).toHaveBeenCalledTimes(1);
    expect(mockPostCredit).toHaveBeenCalledTimes(1);
    expect(mockPostPayment).toHaveBeenCalledTimes(1);

    const chargeCallOrder = mockPostCharge.mock.invocationCallOrder[0];
    const creditCallOrder = mockPostCredit.mock.invocationCallOrder[0];
    const paymentCallOrder = mockPostPayment.mock.invocationCallOrder[0];
    expect(chargeCallOrder).toBeLessThan(creditCallOrder);
    expect(creditCallOrder).toBeLessThan(paymentCallOrder);

    expect(mockGetCurrentBalance).toHaveBeenCalledWith('membership-1');
    expect(res.body.data.openingLedgerEntriesPosted).toBe(3);
    expect(res.body.data.openingBalance).toBe(650);
  });
});
