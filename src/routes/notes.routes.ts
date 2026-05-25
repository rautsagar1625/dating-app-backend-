import { Router } from 'express';
import { listNotes, createNote, updateNote, deleteNote } from '../controllers/notes.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/',      listNotes);
router.post('/',     createNote);
router.put('/:id',   updateNote);
router.delete('/:id', deleteNote);

export default router;
