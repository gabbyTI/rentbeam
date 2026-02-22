import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../lib/prisma.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { generateUploadUrl, generateDownloadUrl, deleteObject } from '../services/storage.js';

const router = Router();
router.use(authenticate);

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Returns the membership if the requesting user is the owning landlord. */
async function getLandlordMembership(membershipId: string, userId: string) {
    const landlord = await prisma.landlordAccount.findUnique({ where: { userId } });
    if (!landlord) throw new ForbiddenError('Not authorized as landlord');

    const membership = await prisma.tenantMembership.findFirst({
        where: { id: membershipId, landlordId: landlord.id },
    });
    if (!membership) throw new NotFoundError('Tenant not found');
    return { landlord, membership };
}

/** Returns the membership if the requesting user is the tenant themselves. */
async function getTenantMembership(membershipId: string, userId: string) {
    const membership = await prisma.tenantMembership.findFirst({
        where: { id: membershipId, userId },
    });
    if (!membership) throw new NotFoundError('Membership not found');
    return membership;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/tenants/:id/documents/upload-url
 * Landlord only. Returns a presigned PUT URL the browser can use to upload directly to storage.
 */
router.post('/:id/documents/upload-url', catchAsync(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { fileName, mimeType, fileSize } = req.body;

    if (!fileName || !mimeType || !fileSize) {
        throw new ValidationError('fileName, mimeType, and fileSize are required');
    }

    const ALLOWED_MIME_TYPES = [
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
    ];
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        throw new ValidationError('Unsupported file type. Allowed: PDF, JPEG, PNG, WEBP, HEIC');
    }

    const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
    if (fileSize > MAX_FILE_SIZE) {
        throw new ValidationError('File size must be 20 MB or less');
    }

    await getLandlordMembership(id, req.user!.id);

    const ext = fileName.split('.').pop() || 'bin';
    const fileKey = `tenants/${id}/${uuidv4()}.${ext}`;
    const uploadUrl = await generateUploadUrl(fileKey, mimeType);

    res.json(apiResponse({ uploadUrl, fileKey }, 'Upload URL generated'));
}));

/**
 * POST /api/tenants/:id/documents/confirm
 * Landlord only. Confirms the upload completed and creates the DB record.
 */
router.post('/:id/documents/confirm', catchAsync(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { fileKey, fileName, type, fileSize, mimeType, notes } = req.body;

    if (!fileKey || !fileName || !type || !fileSize || !mimeType) {
        throw new ValidationError('fileKey, fileName, type, fileSize, and mimeType are required');
    }

    const VALID_TYPES = ['LEASE', 'MOVE_IN_INSPECTION', 'MOVE_OUT_INSPECTION', 'NOTICE', 'ID_VERIFICATION', 'OTHER'];
    if (!VALID_TYPES.includes(type)) {
        throw new ValidationError(`Invalid document type. Must be one of: ${VALID_TYPES.join(', ')}`);
    }

    await getLandlordMembership(id, req.user!.id);

    const document = await prisma.tenantDocument.create({
        data: {
            tenantMembershipId: id,
            type,
            fileName,
            fileKey,
            fileSize,
            mimeType,
            uploadedByUserId: req.user!.id,
            notes: notes || null,
        },
    });

    res.status(201).json(apiResponse(document, 'Document saved'));
}));

/**
 * GET /api/tenants/:id/documents
 * Landlord or the tenant themselves.
 */
router.get('/:id/documents', catchAsync(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const userId = req.user!.id;

    // Allow landlord OR the tenant who owns this membership
    const landlord = await prisma.landlordAccount.findUnique({ where: { userId } });
    if (landlord) {
        // Verify landlord owns this membership
        const membership = await prisma.tenantMembership.findFirst({
            where: { id, landlordId: landlord.id },
        });
        if (!membership) throw new NotFoundError('Tenant not found');
    } else {
        // Must be the tenant themselves
        await getTenantMembership(id, userId);
    }

    const documents = await prisma.tenantDocument.findMany({
        where: { tenantMembershipId: id },
        orderBy: { createdAt: 'desc' },
    });

    res.json(apiResponse(documents));
}));

/**
 * GET /api/tenants/:id/documents/:docId/url
 * Landlord or the tenant themselves. Returns a 1-hour presigned download URL.
 */
router.get('/:id/documents/:docId/url', catchAsync(async (req: AuthRequest, res) => {
    const { id, docId } = req.params;
    const userId = req.user!.id;

    const landlord = await prisma.landlordAccount.findUnique({ where: { userId } });
    if (landlord) {
        const membership = await prisma.tenantMembership.findFirst({
            where: { id, landlordId: landlord.id },
        });
        if (!membership) throw new NotFoundError('Tenant not found');
    } else {
        await getTenantMembership(id, userId);
    }

    const document = await prisma.tenantDocument.findFirst({
        where: { id: docId, tenantMembershipId: id },
    });
    if (!document) throw new NotFoundError('Document not found');

    const url = await generateDownloadUrl(document.fileKey);
    res.json(apiResponse({ url, fileName: document.fileName }));
}));

/**
 * DELETE /api/tenants/:id/documents/:docId
 * Landlord only.
 */
router.delete('/:id/documents/:docId', catchAsync(async (req: AuthRequest, res) => {
    const { id, docId } = req.params;

    await getLandlordMembership(id, req.user!.id);

    const document = await prisma.tenantDocument.findFirst({
        where: { id: docId, tenantMembershipId: id },
    });
    if (!document) throw new NotFoundError('Document not found');

    // Delete from storage first, then DB
    await deleteObject(document.fileKey);
    await prisma.tenantDocument.delete({ where: { id: docId } });

    res.json(apiResponse(null, 'Document deleted'));
}));

export default router;
