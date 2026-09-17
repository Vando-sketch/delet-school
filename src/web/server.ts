import express, { type Request, type Response } from 'express';
import multer from 'multer';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { config } from '../config/index.js';
import { getBankingService } from '../banking/index.js';
import { getFileJobQueue } from '../queue/index.js';

const logger = pino({ name: 'web-server' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]).catch(() => fallback);
}

interface QueueJobStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

interface DocumentEntry {
  filename: string;
  category: string;
  date?: string;
  status: string;
}

export function createWebServer() {
  const app = express();
  const bankingService = getBankingService();

  app.use(express.json());

  // Determine public folder (supports both src/ and dist/ paths)
  const publicDir = path.resolve(__dirname, 'public');
  app.use(express.static(publicDir));

  // Configure Multer for uploading files directly to watchDir
  const storage = multer.diskStorage({
    destination: async (_req, _file, cb) => {
      const inboxDir = path.resolve(config.ingest.watchDir);
      try {
        await fs.mkdir(inboxDir, { recursive: true });
        cb(null, inboxDir);
      } catch (err: unknown) {
        cb(err as Error, inboxDir);
      }
    },
    filename: (_req, file, cb) => {
      // Keep original name, avoid overriding if exists
      const originalName = file.originalname;
      cb(null, originalName);
    },
  });

  const upload = multer({ storage });

  // --- API: Status & Overview ---
  app.get('/api/status', async (_req: Request, res: Response) => {
    let queueStats: QueueJobStats = { waiting: 0, active: 0, completed: 0, failed: 0 };
    try {
      const q = getFileJobQueue();
      queueStats = await withTimeout(
        q.getJobCounts('waiting', 'active', 'completed', 'failed') as unknown as Promise<QueueJobStats>,
        300,
        queueStats,
      );
    } catch {
      // Redis not reachable
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      tailscale: {
        hostname: process.env.TS_HOSTNAME || 'delet-school',
      },
      queue: queueStats,
      inboxPath: config.ingest.watchDir,
      banking: {
        accountsCount: bankingService.getAccounts().length,
        lastSyncAt: bankingService.getState().lastSyncAt,
        hasPendingTan: !!bankingService.getPendingTan(),
      },
    });
  });

  // --- API: Queue & Jobs ---
  app.get('/api/queue', async (_req: Request, res: Response) => {
    try {
      const q = getFileJobQueue();
      const jobsPromise = q.getJobs(['waiting', 'active', 'completed', 'failed'], 0, 50, true);
      const jobs = await withTimeout(jobsPromise, 300, []);
      const formatted = await Promise.all(
        jobs.map(async (j) => {
          const state = await j.getState();
          return {
            id: j.id,
            name: j.name,
            data: j.data,
            status: state,
            timestamp: j.timestamp,
            progress: j.progress,
            failedReason: j.failedReason,
          };
        }),
      );
      res.json({ jobs: formatted });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ jobs: [], error: msg });
    }
  });

  // --- API: File Upload ---
  app.post('/api/upload', upload.array('files', 20), (req: Request, res: Response) => {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    logger.info({ count: files.length, fileNames: files.map((f) => f.originalname) }, 'Uploaded files to watch directory');
    return res.json({
      success: true,
      count: files.length,
      files: files.map((f) => ({
        originalName: f.originalname,
        size: f.size,
        path: f.path,
      })),
    });
  });

  // --- API: Banking ---
  app.get('/api/banking/accounts', (_req: Request, res: Response) => {
    res.json(bankingService.getState());
  });

  app.get('/api/banking/transactions', (req: Request, res: Response) => {
    const iban = req.query.iban as string | undefined;
    const transactions = bankingService.getTransactions(iban);
    res.json({ transactions });
  });

  app.get('/api/banking/statements', (req: Request, res: Response) => {
    const iban = req.query.iban as string | undefined;
    const statements = bankingService.getStatements(iban);
    res.json({ statements });
  });

  app.get('/api/banking/statements/:id/download', (req: Request, res: Response) => {
    const id = req.params.id;
    const statement = bankingService.getStatements().find((s) => s.id === id);
    if (!statement || !statement.path) {
      return res.status(404).json({ error: 'Statement not found' });
    }
    return res.download(statement.path, statement.filename);
  });

  app.post('/api/banking/sync', async (_req: Request, res: Response) => {
    const result = await bankingService.sync();
    res.json(result);
  });

  app.post('/api/banking/tan', async (req: Request, res: Response) => {
    const tan = req.body?.tan;
    if (!tan) {
      return res.status(400).json({ success: false, error: 'TAN is required' });
    }
    const result = await bankingService.submitTan(tan);
    return res.json(result);
  });

  // --- API: Archived Documents ---
  app.get('/api/documents', async (_req: Request, res: Response) => {
    try {
      const watchDir = path.resolve(config.ingest.watchDir);
      const processedDir = path.join(watchDir, config.ingest.processedDirName);
      const failedDir = path.join(watchDir, config.ingest.failedDirName);

      const documents: DocumentEntry[] = [];

      try {
        const processedFiles = await fs.readdir(processedDir);
        for (const f of processedFiles) {
          const stats = await fs.stat(path.join(processedDir, f)).catch(() => null);
          documents.push({
            filename: f,
            category: 'Processed Solution',
            date: stats?.mtime?.toISOString().slice(0, 10),
            status: 'processed',
          });
        }
      } catch {
        // directory doesn't exist yet
      }

      try {
        const failedFiles = await fs.readdir(failedDir);
        for (const f of failedFiles) {
          const stats = await fs.stat(path.join(failedDir, f)).catch(() => null);
          documents.push({
            filename: f,
            category: 'Failed Ingest',
            date: stats?.mtime?.toISOString().slice(0, 10),
            status: 'failed',
          });
        }
      } catch {
        // directory doesn't exist yet
      }

      res.json({ documents });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ documents: [], error: msg });
    }
  });

  // Fallback to index.html for SPA routes
  app.use((_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}
