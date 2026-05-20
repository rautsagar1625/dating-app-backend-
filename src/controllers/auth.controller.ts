import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import prisma from '../services/prisma.service';
import { generateToken } from '../utils/jwt.util';
import { touchLastSeen } from '../services/online.service';
import { trackEvent } from '../services/analytics.service';
import { enqueueDeviceEvaluation } from '../services/fraud/fraud.queue';

const formatUser = (user: any, profile: any) => ({
  id: user.id,
  email: user.email ?? null,
  phone: user.phone ?? null,
  role: user.role ?? 'user',
  name: profile?.username ?? null,
  username: profile?.username ? `@${profile.username}` : null,
  age: profile?.age ?? null,
  gender: profile?.gender ?? null,
  location: profile?.location ?? null,
  bio: profile?.bio ?? null,
  isPrivatePhoto: profile?.isPrivatePhoto ?? false,
  isProfileComplete: !!profile,
});

// POST /api/auth/register
export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, phone, password } = req.body;

    if (!email && !phone) {
      res.status(400).json({ success: false, message: 'Email or phone is required' });
      return;
    }
    if (!password || password.length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      return;
    }

    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email: email ?? undefined }, { phone: phone ?? undefined }] },
    });

    if (existingUser) {
      res.status(409).json({ success: false, message: 'User already exists' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email: email ?? undefined,
        phone: phone ?? undefined,
        password: hashedPassword,
        lastSeen: new Date(),
        wallet: { create: { balance: 50 } }, // 50 bonus credits on signup
      },
    });

    const token = generateToken(user.id);
    trackEvent('register', user.id);
    if (req.device?.fingerprint) {
      enqueueDeviceEvaluation(user.id, req.device.fingerprint, req.device.rawIp ?? '').catch(() => {});
    }

    res.status(201).json({
      success: true,
      data: { user: formatUser(user, null), token },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/login
export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, phone, password } = req.body;

    if ((!email && !phone) || !password) {
      res.status(400).json({ success: false, message: 'Credentials are required' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { OR: [{ email: email ?? undefined }, { phone: phone ?? undefined }] },
      include: { profile: true },
    });

    if (!user) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    await touchLastSeen(user.id);
    trackEvent('login', user.id);
    if (req.device?.fingerprint) {
      enqueueDeviceEvaluation(user.id, req.device.fingerprint, req.device.rawIp ?? '').catch(() => {});
    }

    const token = generateToken(user.id);

    res.status(200).json({
      success: true,
      data: { user: formatUser(user, user.profile), token },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/me  (protected)
export const getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    touchLastSeen(userId).catch(() => {});

    res.status(200).json({
      success: true,
      data: { user: formatUser(user, user.profile) },
    });
  } catch (error) {
    next(error);
  }
};
