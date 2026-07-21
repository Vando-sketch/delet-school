export interface DownloadedFile {
  fileName: string;
  mimeType: string;
  content: Buffer;
}

export interface TaskSolution {
  taskDescription: string;
  proposedSolution: string;
}

export interface ProcessedFileResult {
  originalFileName: string;
  tasksFound: TaskSolution[];
  summaryMarkdown: string;
}

export interface FileProcessor {
  processFile(file: DownloadedFile): Promise<ProcessedFileResult>;
}

export interface NextcloudWriter {
  writeResult(result: ProcessedFileResult, originalFile: DownloadedFile): Promise<{ writtenPath: string }>;
}
