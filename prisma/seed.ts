import 'dotenv/config';
import prisma from '../src/lib/prisma.js';
import { cognitoService } from '../src/services/cognito.js';
import { postCharge, postPayment } from '../src/services/ledger.js';

const LANDLORD_EMAIL = 'landlord.demo@rentbeam.local';
const TENANT_EMAIL = 'tenant.demo@rentbeam.local';
const TEST_PASSWORD = 'DemoPass123!';

async function resetData() {
  await prisma.ledgerEntry.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.tenantDocument.deleteMany();
  await prisma.otpVerification.deleteMany();
  await prisma.tenantMembership.deleteMany();
  await prisma.unit.deleteMany();
  await prisma.property.deleteMany();
  await prisma.landlordAccount.deleteMany();
  await prisma.user.deleteMany();
}

async function ensureCognitoUser(email: string, password: string, name: string) {
  try {
    return await cognitoService.createTenantUser(email, password, name);
  } catch (error: any) {
    if (error?.name === 'UsernameExistsException') {
      await cognitoService.deleteUser(email);
      return cognitoService.createTenantUser(email, password, name);
    }

    throw error;
  }
}

async function main() {
  await resetData();

  const landlordCognitoId = await ensureCognitoUser(LANDLORD_EMAIL, TEST_PASSWORD, 'Demo Landlord');
  const tenantCognitoId = await ensureCognitoUser(TENANT_EMAIL, TEST_PASSWORD, 'Demo Tenant');

  const landlordUser = await prisma.user.create({
    data: {
      cognitoId: landlordCognitoId,
      email: LANDLORD_EMAIL,
      name: 'Demo Landlord',
      firstName: 'Demo',
      lastName: 'Landlord',
      country: 'CA',
      phone: '555-0100',
      landlordAccount: {
        create: {
          payoutsEnabled: true,
          defaultDueDay: 1,
          defaultGracePeriodDays: 5,
          useBusinessName: false,
        },
      },
    },
    include: {
      landlordAccount: true,
    },
  });

  const property = await prisma.property.create({
    data: {
      landlordId: landlordUser.landlordAccount!.id,
      name: 'Demo Building',
      address: '100 King St W, Toronto, ON M5X 1A9, CA',
      streetAddress: '100 King St W',
      city: 'Toronto',
      province: 'ON',
      postalCode: 'M5X 1A9',
      country: 'CA',
      acceptOnlinePayments: true,
    },
  });

  const unit = await prisma.unit.create({
    data: {
      propertyId: property.id,
      name: 'Unit 101',
      rentAmount: 1500,
      dueDay: 1,
      gracePeriodDays: 5,
    },
  });

  const tenantUser = await prisma.user.create({
    data: {
      cognitoId: tenantCognitoId,
      email: TENANT_EMAIL,
      name: 'Demo Tenant',
      firstName: 'Demo',
      lastName: 'Tenant',
      country: 'CA',
      phone: '555-0101',
    },
  });

  const moveInDate = new Date();
  moveInDate.setDate(moveInDate.getDate() - 14);

  const membership = await prisma.tenantMembership.create({
    data: {
      userId: tenantUser.id,
      unitId: unit.id,
      landlordId: landlordUser.landlordAccount!.id,
      moveInDate,
      inviteStatus: 'ACCEPTED',
      autopayEnabled: false,
      status: 'ACTIVE',
      leaseStartDate: moveInDate,
      leaseType: 'MONTH_TO_MONTH',
      notes: 'Seeded demo tenant for local testing.',
    },
    include: {
      user: true,
      unit: {
        include: {
          property: true,
        },
      },
    },
  });

  const rentChargeDate = new Date();
  rentChargeDate.setDate(1);
  await postCharge({
    tenantMembershipId: membership.id,
    effectiveDate: rentChargeDate,
    code: 'RNTA',
    description: 'Monthly Rent',
    amount: 1500,
    source: 'SYSTEM',
    referenceId: `SEED-CHARGE-${membership.id}`,
  });

  const paymentDate = new Date(rentChargeDate);
  paymentDate.setDate(paymentDate.getDate() + 2);
  await postPayment({
    tenantMembershipId: membership.id,
    effectiveDate: paymentDate,
    description: 'Seed Payment',
    amount: 500,
    source: 'MANUAL',
    referenceId: `SEED-PAYMENT-${membership.id}`,
    postedBy: landlordUser.id,
  });

  console.log('Seed complete');
  console.log(`Landlord: ${LANDLORD_EMAIL} / ${TEST_PASSWORD}`);
  console.log(`Tenant: ${TENANT_EMAIL} / ${TEST_PASSWORD}`);
  console.log(`Invite/tenant membership: ${membership.id}`);
}

main()
  .catch((error) => {
    console.error('Seed failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });