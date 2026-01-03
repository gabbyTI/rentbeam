import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { UnauthorizedError, NotFoundError } from '../lib/errors.js';
import prisma from '../lib/prisma.js';

// Lazy-load Cognito JWT verifier
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID!,
      tokenUse: 'access',
      clientId: process.env.COGNITO_CLIENT_ID!,
      jwksCache: {
        penaltyBox: true,
      },
    });
  }
  return verifier;
}

export interface AuthRequest extends Request {
  user?: {
    id: string;
    cognitoId: string;
    email: string;
    name: string;
  };
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('No token provided');
    }

    const token = authHeader.split(' ')[1];

    // Verify Cognito token
    const payload = await getVerifier().verify(token);
    
    // Find user in database
    const user = await prisma.user.findUnique({
      where: { cognitoId: payload.sub }
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Attach user to request
    req.user = {
      id: user.id,
      cognitoId: user.cognitoId!,
      email: user.email,
      name: user.name
    };

    next();
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof NotFoundError) {
      next(error);
    } else {
      next(new UnauthorizedError('Invalid token'));
    }
  }
};
