/**
 * Voice layer endpoints that sit on top of the AI chat agent (ported from
 * IBM-Project-Imagine/client-demo's voiceRoutes.ts pattern).
 *
 * These are intentionally two small endpoints rather than one monolith: the
 * agent turn itself reuses the existing POST /api/ai/chat path. A typical
 * voice flow is: transcribe -> chat -> synthesize.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { VoiceProviderFactory } from '../services/voice/voiceProvider.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';

const router = Router();

// POST /api/voice/transcribe  { audioBase64, mimeType, language? } -> { text, provider }
router.post('/transcribe', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { audioBase64, mimeType, language } = req.body as {
        audioBase64?: string;
        mimeType?: string;
        language?: string;
      };
      if (!audioBase64 || typeof audioBase64 !== 'string') {
        throw new ValidationError('audioBase64 (string) is required', { audioBase64: 'required' });
      }

      const provider = VoiceProviderFactory.create();
      const result = await provider.transcribe({
        audioBase64,
        mimeType: typeof mimeType === 'string' ? mimeType : 'audio/wav',
        ...(typeof language === 'string' && { language }),
      });

      const body: ApiSuccess<typeof result> = { success: true, data: result };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

// POST /api/voice/synthesize  { text, voice? } -> { audioBase64, mimeType, provider }
router.post('/synthesize', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const { text, voice } = req.body as { text?: string; voice?: string };
      if (!text || typeof text !== 'string') {
        throw new ValidationError('text (string) is required', { text: 'required' });
      }

      const provider = VoiceProviderFactory.create();
      const result = await provider.synthesize({
        text,
        ...(typeof voice === 'string' && { voice }),
      });

      const body: ApiSuccess<typeof result> = { success: true, data: result };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

export { router as voiceRouter };
