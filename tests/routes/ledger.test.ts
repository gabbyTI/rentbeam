/**
 * tests/routes/ledger.test.ts
 *
 * Integration-style tests for the ledger HTTP routes.
 * The Express app is mounted directly; auth middleware and Prisma are mocked.
 * Tests cover: input validation, access control, and correct service delegation.
 */

import request from 'supertest';
import express from 'express';
import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

// ─── Mock auth middleware ─────────────────────────────────────────────────────
const mockUser = { id: 'user-landlord-1', cognitoId: 'cog-1', email: 'landlord@test.com', name: 'Test Landlord' };

jest.mock('../../src/middleware/auth.js', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = mockUser;
    next();
  },
}));

// ─── Mock Prisma (self-contained CJS factory) ─────────────────────────────────
jest.mock('../../src/lib/prisma.js', () => {
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});
jest.mock('../../src/lib/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ─── Mock ledger service ──────────────────────────────────────────────────────
const mockGetStatement = jest.fn();
const mockGetLedgerSummary = jest.fn();
const mockPostCharge = jest.fn();
const mockPostPayment = jest.fn();
const mockPostCredit = jest.fn();

jest.mock('../../src/services/ledger.js', () => ({
  getStatement: (...args: any[]) => mockGetStatement(...args),
  getLedgerSummary: (...args: any[]) => mockGetLedgerSummary(...args),
  postCharge: (...args: any[]) => mockPostCharge(...args),
  postPayment: (...args: any[]) => mockPostPayment(...args),
  postCredit: (...args: any[]) => mockPostCredit(...args),
}));

import prismaMock_ from '../../src/lib/prisma.js';
const prismaMock = prismaMock_ as unknown as DeepMockProxy<PrismaClient>;
import ledgerRoutes from '../../src/routes/ledger.js';

// ─── Reset mocks between tests ────────────────────────────────────────────────
beforeEach(() => {
  const { mockReset } = require('jest-mock-extended');
  mockReset(prismaMock);
});

// ─── App setup ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ledger', ledgerRoutes);
  // Simple error handler so 4xx errors return JSON
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

// ─── Test data ────────────────────────────────────────────────────────────────

const MEMBERSHIP_ID = '148a2db6-1f09-49f6-96d7-7d66333c41fe';

/** Simulate the landlord owning this tenant membership */
function mockLandlordAccess() {
  const landlord = { id: 'landlord-1', userId: mockUser.id };
  prismaMock.landlordAccount.findUnique.mockResolvedValue(landlord as any);
  prismaMock.tenantMembership.findUnique.mockResolvedValue({
    id: MEMBERSHIP_ID,
    userId: 'user-tenant-1',
    landlordId: 'landlord-1',
    unit: { id: 'unit-1', property: {} },
  } as any);
}

/** Simulate the tenant accessing their own ledger */
function mockTenantAccess() {
  prismaMock.landlordAccount.findUnique.mockResolvedValue(null); // not a landlord
  prismaMock.tenantMembership.findUnique.mockResolvedValue({
    id: MEMBERSHIP_ID,
    userId: mockUser.id, // same user
    landlordId: 'landlord-1',
    unit: { id: 'unit-1', property: {} },
  } as any);
}

// ─── GET /api/ledger/:id ──────────────────────────────────────────────────────

describe('GET /api/ledger/:id', () => {
  it('returns the statement for landlord', async () => {
    mockLandlordAccess();
    mockGetStatement.mockResolvedValue([
      { id: 'e1', description: 'Rent', balanceAfter: 1000, chargeAmount: 1000, paymentAmount: null },
    ]);

    const res = await request(buildApp()).get(`/api/ledger/${MEMBERSHIP_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].balanceAfter).toBe(1000);
  });

  it('returns the statement for a tenant viewing their own ledger', async () => {
    mockTenantAccess();
    mockGetStatement.mockResolvedValue([]);

    const res = await request(buildApp()).get(`/api/ledger/${MEMBERSHIP_ID}`);
    expect(res.status).toBe(200);
  });

  it('returns 404 when tenant membership does not exist', async () => {
    prismaMock.landlordAccount.findUnique.mockResolvedValue(null);
    prismaMock.tenantMembership.findUnique.mockResolvedValue(null);

    const res = await request(buildApp()).get(`/api/ledger/${MEMBERSHIP_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 when user has no relation to the membership', async () => {
    prismaMock.landlordAccount.findUnique.mockResolvedValue(null);
    prismaMock.tenantMembership.findUnique.mockResolvedValue({
      id: MEMBERSHIP_ID,
      userId: 'completely-different-user',
      landlordId: 'other-landlord',
      unit: {},
    } as any);

    const res = await request(buildApp()).get(`/api/ledger/${MEMBERSHIP_ID}`);
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/ledger/:id/balance ─────────────────────────────────────────────

describe('GET /api/ledger/:id/balance', () => {
  it('returns current balance summary', async () => {
    mockLandlordAccess();
    mockGetLedgerSummary.mockResolvedValue({
      currentBalance: 450,
      lastPostedDate: new Date(),
      totalCharged: 2000,
      totalPaid: 1550,
    });

    const res = await request(buildApp()).get(`/api/ledger/${MEMBERSHIP_ID}/balance`);

    expect(res.status).toBe(200);
    expect(res.body.data.currentBalance).toBe(450);
    expect(res.body.data.totalCharged).toBe(2000);
  });
});

// ─── POST /api/ledger/:id/charge ─────────────────────────────────────────────

describe('POST /api/ledger/:id/charge', () => {
  it('posts a charge and returns 201', async () => {
    mockLandlordAccess();
    mockPostCharge.mockResolvedValue({ id: 'new-entry', code: 'FEE', balanceAfter: 1025 });

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/charge`)
      .send({ code: 'FEE', description: 'FOB purchase', amount: 25 });

    expect(res.status).toBe(201);
    expect(mockPostCharge).toHaveBeenCalledTimes(1);
    const call = mockPostCharge.mock.calls[0][0] as any;
    expect(call.code).toBe('FEE');
    expect(call.amount).toBe(25);
    expect(call.source).toBe('MANUAL');
    expect(call.postedBy).toBe(mockUser.id);
  });

  it('returns 400 when code is missing', async () => {
    mockLandlordAccess();

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/charge`)
      .send({ description: 'Something', amount: 50 });

    expect(res.status).toBe(400);
    expect(mockPostCharge).not.toHaveBeenCalled();
  });

  it('returns 400 when amount is missing', async () => {
    mockLandlordAccess();

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/charge`)
      .send({ code: 'FEE', description: 'Fee' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is zero', async () => {
    mockLandlordAccess();

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/charge`)
      .send({ code: 'FEE', description: 'Zero fee', amount: 0 });

    expect(res.status).toBe(400);
  });

  it('returns 403 when a tenant tries to post a charge', async () => {
    mockTenantAccess(); // tenant can't post charges

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/charge`)
      .send({ code: 'FEE', description: 'Fee', amount: 50 });

    expect(res.status).toBe(403);
    expect(mockPostCharge).not.toHaveBeenCalled();
  });

  it('uppercases the charge code', async () => {
    mockLandlordAccess();
    mockPostCharge.mockResolvedValue({ id: 'e1' });

    await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/charge`)
      .send({ code: 'fee', description: 'Lowercase code', amount: 25 });

    const call = mockPostCharge.mock.calls[0][0] as any;
    expect(call.code).toBe('FEE');
  });
});

// ─── POST /api/ledger/:id/payment ─────────────────────────────────────────────

describe('POST /api/ledger/:id/payment', () => {
  it('posts a payment and returns 201', async () => {
    mockLandlordAccess();
    mockPostPayment.mockResolvedValue({ id: 'pay-1', balanceAfter: 400 });

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/payment`)
      .send({ description: 'Cheque #5678 – July rent', amount: 600 });

    expect(res.status).toBe(201);
    expect(mockPostPayment).toHaveBeenCalledTimes(1);
    const call = mockPostPayment.mock.calls[0][0] as any;
    expect(call.amount).toBe(600);
    expect(call.source).toBe('MANUAL');
  });

  it('returns 400 when description is missing', async () => {
    mockLandlordAccess();

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/payment`)
      .send({ amount: 600 });

    expect(res.status).toBe(400);
  });

  it('returns 403 when tenant tries to post a payment', async () => {
    mockTenantAccess();

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/payment`)
      .send({ description: 'Cheque', amount: 600 });

    expect(res.status).toBe(403);
  });
});

// ─── POST /api/ledger/:id/credit ─────────────────────────────────────────────

describe('POST /api/ledger/:id/credit', () => {
  it('posts a credit and returns 201', async () => {
    mockLandlordAccess();
    mockPostCredit.mockResolvedValue({ id: 'cred-1', balanceAfter: 200 });

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/credit`)
      .send({ description: 'Concession – August 2026', amount: 300 });

    expect(res.status).toBe(201);
    expect(mockPostCredit).toHaveBeenCalledTimes(1);
    const call = mockPostCredit.mock.calls[0][0] as any;
    expect(call.amount).toBe(300);
    expect(call.code).toBe('ADJ'); // default code when none provided
  });

  it('uses provided code when given', async () => {
    mockLandlordAccess();
    mockPostCredit.mockResolvedValue({ id: 'cred-2' });

    await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/credit`)
      .send({ code: 'conc', description: 'Concession', amount: 100 });

    const call = mockPostCredit.mock.calls[0][0] as any;
    expect(call.code).toBe('CONC'); // uppercased
  });

  it('returns 400 when amount is negative', async () => {
    mockLandlordAccess();

    const res = await request(buildApp())
      .post(`/api/ledger/${MEMBERSHIP_ID}/credit`)
      .send({ description: 'Bad credit', amount: -50 });

    expect(res.status).toBe(400);
  });
});
