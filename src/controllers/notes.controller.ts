import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';

// ── GET /api/notes  (own notes list) ─────────────────────────────────────────
export const listNotes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const notes = await prisma.note.findMany({
      where:   { userId },
      orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
      select:  { id: true, title: true, content: true, color: true, isPinned: true, createdAt: true, updatedAt: true },
    });

    res.json({ success: true, data: notes });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/notes  (create) ─────────────────────────────────────────────────
export const createNote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { title, content, color = '#7B2FF7', isPinned = false } = req.body;

    if (!title?.trim()) {
      res.status(400).json({ success: false, message: 'title is required' });
      return;
    }
    if (!content?.trim()) {
      res.status(400).json({ success: false, message: 'content is required' });
      return;
    }

    const note = await prisma.note.create({
      data: {
        userId,
        title:    title.trim(),
        content:  content.trim(),
        color:    color || '#7B2FF7',
        isPinned: Boolean(isPinned),
      },
    });

    res.status(201).json({ success: true, data: note });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/notes/:id  (update) ──────────────────────────────────────────────
export const updateNote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const noteId = req.params['id'] as string;
    const { title, content, color, isPinned } = req.body;

    // Ensure ownership
    const existing = await prisma.note.findUnique({ where: { id: noteId }, select: { userId: true } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Note not found' });
      return;
    }
    if (existing.userId !== userId) {
      res.status(403).json({ success: false, message: 'Forbidden' });
      return;
    }

    const note = await prisma.note.update({
      where: { id: noteId },
      data: {
        ...(title    !== undefined ? { title:    title.trim()   } : {}),
        ...(content  !== undefined ? { content:  content.trim() } : {}),
        ...(color    !== undefined ? { color:    color as string } : {}),
        ...(isPinned !== undefined ? { isPinned: Boolean(isPinned) } : {}),
      },
    });

    res.json({ success: true, data: note });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/notes/:id  (delete) ───────────────────────────────────────────
export const deleteNote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const noteId = req.params['id'] as string;

    const existing = await prisma.note.findUnique({ where: { id: noteId }, select: { userId: true } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Note not found' });
      return;
    }
    if (existing.userId !== userId) {
      res.status(403).json({ success: false, message: 'Forbidden' });
      return;
    }

    await prisma.note.delete({ where: { id: noteId } });
    res.json({ success: true, message: 'Note deleted' });
  } catch (error) {
    next(error);
  }
};
