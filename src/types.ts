export interface DownloadedFile {
  fileName: string;
  mimeType: string;
  content: Buffer;
}

export interface GraphClient {
  downloadDriveItem(driveId: string, itemId: string): Promise<DownloadedFile>;
  createSubscription(input: {
    resource: string;
    changeType: string;
    notificationUrl: string;
    expirationDateTime: string;
    clientState?: string;
  }): Promise<{ id: string; expirationDateTime: string }>;
  renewSubscription(subscriptionId: string, expirationDateTime: string): Promise<void>;
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
