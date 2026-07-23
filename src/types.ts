import type { FachKey } from './fach.js';

export interface TaskSolution {
  title: string;
  taskDescription: string;
  proposedSolution: string;
  quelle?: string;
}

export interface ProcessedFileResult {
  originalFileName: string;
  isMaterialblatt: boolean;
  fach: FachKey;
  lernfeld?: string;
  thema: string;
  tasksFound: TaskSolution[];
}

export interface VisionPage {
  pageNumber: number;
  imagePath: string;
}

export interface ExtractionResult {
  markdown: string;
  visionPages: VisionPage[];
  ranOcr: boolean;
  archivalPdfPath: string;
}

export interface FileProcessor {
  processFile(fileName: string, extraction: ExtractionResult): Promise<ProcessedFileResult>;
}

export type NextcloudWriteContent = { kind: 'pdf'; bytes: Buffer } | { kind: 'material'; sourcePath: string };

export interface NextcloudWriter {
  writeResult(
    result: ProcessedFileResult,
    content: NextcloudWriteContent,
    datum: string,
  ): Promise<{ writtenPath: string }>;
}
