import prisma from '../src/lib/prisma.js';

async function updateExistingPayments() {
  console.log('Updating existing payments with fee breakdown...');
  
  // Get all payments with rentAmount = 0
  const paymentsToUpdate = await prisma.payment.findMany({
    where: {
      rentAmount: 0,
    },
  });
  
  console.log(`Found ${paymentsToUpdate.length} payments to update`);
  
  // Update each payment individually
  for (const payment of paymentsToUpdate) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        rentAmount: payment.amount,
        totalAmount: payment.amount,
        processingFee: 0, // No fee for old manual payments
      },
    });
  }
  
  console.log(`Successfully updated ${paymentsToUpdate.length} payment records`);
  
  await prisma.$disconnect();
}

updateExistingPayments().catch((error) => {
  console.error('Error updating payments:', error);
  process.exit(1);
});
