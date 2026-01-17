import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkHistory() {
  const history = await prisma.subscriptionHistory.findMany({
    where: { userId: '1065b2cc-2789-44ad-ad94-a1ec7d7b55fb' },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  
  console.log('Recent Subscription History Events:');
  console.log('===================================');
  history.forEach(event => {
    console.log(`${event.createdAt.toISOString()} - ${event.eventType}: ${event.fromPlan || 'none'} -> ${event.toPlan || 'none'}`);
    if (event.metadata) {
      console.log(`  Metadata: ${JSON.stringify(event.metadata)}`);
    }
  });
  
  await prisma.$disconnect();
}

checkHistory().catch(console.error);
