import jwt from 'jsonwebtoken';
import { env } from '../config/env';

interface TokenPayload {
  userId: string;
  iat?: number;
  exp?: number;
}

export const generateAccessToken = (userId: string): string =>
  jwt.sign({ userId }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_EXPIRES as jwt.SignOptions['expiresIn'],
  });

export const generateRefreshToken = (userId: string): string =>
  jwt.sign({ userId }, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_REFRESH_EXPIRES as jwt.SignOptions['expiresIn'],
  });

export const verifyToken = (token: string): TokenPayload =>
  jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as TokenPayload;

export const verifyRefreshToken = (token: string): TokenPayload =>
  jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as TokenPayload;

// Keep backward-compat alias used by auth.controller.ts
export const generateToken = generateAccessToken;
