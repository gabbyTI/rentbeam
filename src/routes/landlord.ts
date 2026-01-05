import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

// PATCH /api/landlord/preferences - Update landlord payment preferences
router.patch('/preferences', authenticate, catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { defaultDueDay, defaultGracePeriodDays } = req.body;

  // Validation
  if (defaultDueDay !== undefined) {
    const dueDay = parseInt(defaultDueDay);
    if (isNaN(dueDay) || dueDay < 1 || dueDay > 28) {
      throw new ValidationError('Default due day must be between 1 and 28');
    }
  }

  if (defaultGracePeriodDays !== undefined) {
    const graceDays = parseInt(defaultGracePeriodDays);
    if (isNaN(graceDays) || graceDays < 0 || graceDays > 10) {
      throw new ValidationError('Default grace period must be between 0 and 10 days');
    }
  }

  // Find landlord account
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId }
  });

  if (!landlord) {
    throw new NotFoundError('Landlord account not found');
  }

  // Build update object with only provided fields
  const updateData: any = {};
  if (defaultDueDay !== undefined) updateData.defaultDueDay = parseInt(defaultDueDay);
  if (defaultGracePeriodDays !== undefined) updateData.defaultGracePeriodDays = parseInt(defaultGracePeriodDays);

  // Update landlord preferences
  const updatedLandlord = await prisma.landlordAccount.update({
    where: { id: landlord.id },
    data: updateData,
    select: {
      id: true,
      defaultDueDay: true,
      defaultGracePeriodDays: true,
    },
  });

  res.json(apiResponse(updatedLandlord, 'Preferences updated successfully'));
}));

export default router;
