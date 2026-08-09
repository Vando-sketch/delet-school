export interface TaskSolution {
  title: string;
  taskDescription: string;
  proposedSolution: string;
  source?: string;
}

export interface ProcessedFileResult {
  originalFileName: string;
  isReferenceSheet: boolean;
  subject: string;
  module?: string;
  topic: string;
  backgroundContext?: string;
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

/** A lightweight excerpt of one sibling file from the same ingest batch, for classification context. */
export interface SiblingManifestEntry {
  fileName: string;
  excerpt: string;
}

export interface FileProcessor {
  processFile(
    fileName: string,
    extraction: ExtractionResult,
    siblings?: SiblingManifestEntry[],
  ): Promise<ProcessedFileResult>;
}

export type NextcloudWriteContent = { kind: 'pdf'; bytes: Buffer } | { kind: 'material'; sourcePath: string };

export interface NextcloudWriter {
  writeResult(
    result: ProcessedFileResult,
    content: NextcloudWriteContent,
    date: string,
  ): Promise<{ writtenPath: string }>;
}
