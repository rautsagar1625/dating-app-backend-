import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';

// ── GET /api/news  (public list — paginated) ──────────────────────────────────
export const listNews = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page = '1', limit = '20', category } = req.query;
    const pageNum  = Math.max(1, parseInt(page  as string, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));
    const cat      = Array.isArray(category) ? (category[0] as string) : (category as string | undefined);

    const where = {
      isPublished: true,
      ...(cat ? { category: cat } : {}),
    };

    const [posts, total] = await prisma.$transaction([
      prisma.newsPost.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip:    (pageNum - 1) * limitNum,
        take:    limitNum,
        select:  { id: true, title: true, content: true, imageUrl: true, category: true, publishedAt: true },
      }),
      prisma.newsPost.count({ where }),
    ]);

    res.json({ success: true, data: posts, meta: { page: pageNum, limit: limitNum, total } });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/news/:id  (single post) ─────────────────────────────────────────
export const getNewsPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params['id'] as string;
    const post = await prisma.newsPost.findUnique({
      where:  { id },
      select: { id: true, title: true, content: true, imageUrl: true, category: true, publishedAt: true },
    });

    if (!post) {
      res.status(404).json({ success: false, message: 'Post not found' });
      return;
    }

    res.json({ success: true, data: post });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/news  (admin: create) ──────────────────────────────────────────
export const createNewsPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { title, content, imageUrl, category = 'update', isPublished = false } = req.body;

    if (!title?.trim() || !content?.trim()) {
      res.status(400).json({ success: false, message: 'title and content are required' });
      return;
    }

    const post = await prisma.newsPost.create({
      data: {
        title:       title.trim(),
        content:     content.trim(),
        imageUrl:    imageUrl?.trim() || null,
        category:    category as string,
        isPublished: Boolean(isPublished),
        publishedAt: isPublished ? new Date() : null,
      },
    });

    res.status(201).json({ success: true, data: post });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/news/:id  (admin: update) ────────────────────────────────────────
export const updateNewsPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params['id'] as string;
    const { title, content, imageUrl, category, isPublished } = req.body;

    const existing = await prisma.newsPost.findUnique({ where: { id }, select: { id: true, isPublished: true } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Post not found' });
      return;
    }

    const post = await prisma.newsPost.update({
      where: { id },
      data: {
        ...(title     !== undefined ? { title:     title.trim()   } : {}),
        ...(content   !== undefined ? { content:   content.trim() } : {}),
        ...(imageUrl  !== undefined ? { imageUrl:  imageUrl?.trim() || null } : {}),
        ...(category  !== undefined ? { category:  category as string } : {}),
        ...(isPublished !== undefined ? {
          isPublished: Boolean(isPublished),
          publishedAt: Boolean(isPublished) && !existing.isPublished ? new Date() : undefined,
        } : {}),
      },
    });

    res.json({ success: true, data: post });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/news/:id  (admin: delete) ─────────────────────────────────────
export const deleteNewsPost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params['id'] as string;
    await prisma.newsPost.delete({ where: { id } });
    res.json({ success: true, message: 'Post deleted' });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ success: false, message: 'Post not found' });
      return;
    }
    next(error);
  }
};
